#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

dry_run=0
targets=()
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then dry_run=1; else targets+=("$arg"); fi
done
if (( ${#targets[@]} == 0 )); then targets=(all); fi

for target in "${targets[@]}"; do
  case "$target" in all|product|backend|text|coach|voice|retriever|nemoclaw) ;; *)
    echo "usage: $0 [all|product|backend|text|coach|voice|retriever|nemoclaw ...] [--dry-run]" >&2
    exit 2
  esac
done

if (( dry_run )); then
  for target in "${targets[@]}"; do
    case "$target" in
      all) echo "restart all: stop.sh -> start.sh" ;;
      product) echo "restart product: backend + observer" ;;
      backend) echo "restart backend: services/backend.sh stop -> start" ;;
      text) echo "restart text: models/post-session.sh stop -> start" ;;
      coach) echo "restart coach: models/coach.sh stop -> start" ;;
      voice) echo "restart voice: models/realtime.sh stop -> start" ;;
      retriever) echo "restart retriever: services/retriever.sh stop -> start" ;;
      nemoclaw) echo "restart nemoclaw sandbox: stop -> start; preserve sandbox data" ;;
    esac
  done
  exit 0
fi

for target in "${targets[@]}"; do
  case "$target" in
    all)
      "$DIR/stop.sh"
      "$DIR/start.sh"
      ;;
    product)
      "$DIR/services/backend.sh" stop
      "$DIR/services/observer.sh" stop
      "$DIR/services/backend.sh" start
      "$DIR/services/observer.sh" start
      ;;
    backend)
      "$DIR/services/backend.sh" stop
      "$DIR/services/backend.sh" start
      ;;
    text)
      "$DIR/models/post-session.sh" stop
      "$DIR/models/post-session.sh" start
      "$DIR/services/nemoclaw.sh" configure-runtime
      ;;
    coach)
      "$DIR/models/coach.sh" stop
      "$DIR/models/coach.sh" start
      ;;
    voice)
      "$DIR/models/realtime.sh" stop
      "$DIR/models/realtime.sh" start
      ;;
    retriever)
      "$DIR/services/retriever.sh" stop
      "$DIR/services/retriever.sh" start
      ;;
    nemoclaw)
      "$DIR/services/nemoclaw.sh" stop
      "$DIR/services/nemoclaw.sh" start
      ;;
  esac
done
