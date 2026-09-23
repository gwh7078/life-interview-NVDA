#!/usr/bin/env bash
set -euo pipefail
umask 077

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[FAIL] The local NeMo Retriever LaunchAgent is supported only on macOS." >&2
  exit 1
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

label="com.gwh.nemo-retriever"
domain="gui/$(id -u)"
runtime_dir="${NEMO_RETRIEVER_HOME:-$HOME/.local/share/nemo-retriever}"
if [[ ! -d "$runtime_dir" ]]; then
  echo "[FAIL] NeMo Retriever runtime is not provisioned at $runtime_dir." >&2
  echo "Install its venv and retriever-service.yaml there, then rerun this script; see docs/AI开发联调环境.md, section 10.3." >&2
  exit 1
fi
runtime_dir="$(cd "$runtime_dir" && pwd -P)"
retriever="$runtime_dir/.venv/bin/retriever"
config="$runtime_dir/retriever-service.yaml"
runtime_env="$runtime_dir/.env"
agent_dir="$HOME/Library/LaunchAgents"
plist="$agent_dir/$label.plist"
launcher="$runtime_dir/start-retriever.sh"
target="$domain/$label"

if [[ ! -x "$retriever" || ! -f "$config" ]]; then
  echo "[FAIL] NeMo Retriever runtime is not provisioned at $runtime_dir." >&2
  echo "Install its venv and retriever-service.yaml there, then rerun this script; see docs/AI开发联调环境.md, section 10.3." >&2
  exit 1
fi
if [[ -L "$runtime_env" || ( -e "$runtime_env" && ! -f "$runtime_env" ) ]]; then
  echo "[FAIL] Retriever .env must be a regular file, not a symlink: $runtime_env" >&2
  exit 1
fi
if [[ -L "$launcher" || ( -e "$launcher" && ! -f "$launcher" ) || -L "$plist" || ( -e "$plist" && ! -f "$plist" ) ]]; then
  echo "[FAIL] Refusing to replace a non-regular Retriever service file." >&2
  exit 1
fi

mkdir -p "$agent_dir"
[[ -e "$runtime_env" ]] || : > "$runtime_env"
chmod 600 "$runtime_env"
env_before="$(shasum -a 256 "$runtime_env" | awk '{print $1}')"
if command -v swift >/dev/null 2>&1; then
  swift scripts/codex-keychain.swift sync-key "$runtime_env" DASHSCOPE_API_KEY
else
  echo "[WARN] Swift is unavailable; retained the existing private Retriever .env without Keychain sync." >&2
fi
chmod 600 "$runtime_env"
env_after="$(shasum -a 256 "$runtime_env" | awk '{print $1}')"

if grep -q 'DASHSCOPE_API_KEY' "$config"; then
  has_dashscope_key=0
  if python3 - "$runtime_env" <<'PY'
import sys
from pathlib import Path

for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    stripped = line.strip()
    if stripped.startswith("DASHSCOPE_API_KEY="):
        value = stripped.partition("=")[2].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        sys.exit(0 if value else 1)
sys.exit(1)
PY
  then
    has_dashscope_key=1
  fi
  if (( ! has_dashscope_key )); then
    echo "[WARN] Retriever config references DASHSCOPE_API_KEY, but it is absent from the login Keychain/runtime .env. Configure it in this macOS user's Keychain before real retrieval." >&2
  fi
fi

launcher_tmp="$(mktemp "$runtime_dir/.start-retriever.XXXXXX")"
cat > "$launcher_tmp" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
umask 077
runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
set -a
. "$runtime_dir/.env"
set +a
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost,::1"
export no_proxy="${no_proxy:+$no_proxy,}127.0.0.1,localhost,::1"
exec "$runtime_dir/.venv/bin/retriever" service start --config "$runtime_dir/retriever-service.yaml"
SH
chmod 700 "$launcher_tmp"
files_changed=0
if [[ ! -f "$launcher" ]] || ! cmp -s "$launcher_tmp" "$launcher"; then
  mv "$launcher_tmp" "$launcher"
  files_changed=1
else
  rm "$launcher_tmp"
  chmod 700 "$launcher"
fi

plist_tmp="$(mktemp "$agent_dir/.$label.XXXXXX")"
python3 - "$plist_tmp" "$runtime_dir" "$launcher" "$label" <<'PY'
import plistlib
import sys

path, runtime_dir, launcher, label = sys.argv[1:]
with open(path, "wb") as output:
    plistlib.dump({
        "Label": label,
        "ProgramArguments": ["/bin/bash", launcher],
        "WorkingDirectory": runtime_dir,
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "StandardOutPath": f"{runtime_dir}/launchd.stdout.log",
        "StandardErrorPath": f"{runtime_dir}/launchd.stderr.log",
    }, output, fmt=plistlib.FMT_XML, sort_keys=True)
PY
chmod 644 "$plist_tmp"
if [[ ! -f "$plist" ]] || ! cmp -s "$plist_tmp" "$plist"; then
  mv "$plist_tmp" "$plist"
  files_changed=1
else
  rm "$plist_tmp"
  chmod 644 "$plist"
fi

loaded=0
if launchctl print "$target" >/dev/null 2>&1; then
  loaded=1
fi
env_changed=0
[[ "$env_before" == "$env_after" ]] || env_changed=1
if (( loaded && (files_changed || env_changed) )); then
  launchctl bootout "$target" 2>/dev/null || true
  loaded=0
fi
if (( ! loaded )); then
  launchctl enable "$target"
  launchctl bootstrap "$domain" "$plist"
  echo "[OK] Installed and started NeMo Retriever LaunchAgent: $target"
elif (( env_changed )); then
  launchctl kickstart -k "$target"
  echo "[OK] Refreshed NeMo Retriever LaunchAgent credentials: $target"
else
  echo "[OK] NeMo Retriever LaunchAgent is installed and current: $target"
fi
