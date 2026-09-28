#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib/common.sh"

action="${1:-status}"
shift || true
dry_run=0
targets=()
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then dry_run=1; else targets+=("$arg"); fi
done
if (( ${#targets[@]} == 0 )); then targets=(text coach voice); fi

script_for() {
  case "$1" in
    text) printf '%s' "$DIR/models/post-session.sh" ;;
    coach) printf '%s' "$DIR/models/coach.sh" ;;
    voice) printf '%s' "$DIR/models/realtime.sh" ;;
    *) return 1 ;;
  esac
}
for target in "${targets[@]}"; do
  script_for "$target" >/dev/null || { echo "usage: $0 {status|sync|prefetch} [text|coach|voice ...] [--dry-run]" >&2; exit 2; }
done

case "$action" in
  status)
    printf '%-10s %s\n' SERVICE STATE
    for target in "${targets[@]}"; do
      script="$(script_for "$target")"
      value="$("$script" status 2>/dev/null | tail -1 || true)"
      printf '%-10s %s\n' "$target" "${value:-UNKNOWN}"
    done
    ;;
  prefetch)
    if (( dry_run )); then
      printf 'DRY-RUN prefetch %s\n' "${targets[*]}"
      exit 0
    fi
    jobs=() names=()
    for target in "${targets[@]}"; do
      script="$(script_for "$target")"
      "$script" prefetch >"$SPARK_LOG_DIR/prefetch-$target.log" 2>&1 &
      jobs+=("$!"); names+=("$target")
    done
    failed=0
    for i in "${!jobs[@]}"; do
      if ! wait "${jobs[$i]}"; then warn "prefetch failed: ${names[$i]}"; failed=1; fi
    done
    (( failed == 0 ))
    ;;
  sync)
    if (( dry_run )); then
      printf 'DRY-RUN sync model artifacts %s; restart only the affected service afterward\n' "${targets[*]}"
      exit 0
    fi
    for target in "${targets[@]}"; do
      script="$(script_for "$target")"
      "$script" prefetch
    done
    log "Model artifacts synced. Restart only the changed service with restart.sh <text|coach|voice>."
    ;;
  *) echo "usage: $0 {status|sync|prefetch} [text|coach|voice ...] [--dry-run]" >&2; exit 2 ;;
esac
