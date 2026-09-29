#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <target-database-path>" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 - "$repo_root/data/life-interview-sample.db" "$1" <<'PY'
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

source = Path(sys.argv[1]).resolve()
target = Path(sys.argv[2]).expanduser().resolve()
if source == target:
    raise SystemExit("Refusing to use the tracked sample as a live database.")
if not source.is_file():
    raise SystemExit(f"Sample database is missing: {source}")
if target.exists() or target.is_symlink() or Path(f"{target}-wal").exists() or Path(f"{target}-shm").exists():
    print(f"Existing database state found at {target}; preserving it.")
    raise SystemExit(0)

target.parent.mkdir(parents=True, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
os.close(fd)
try:
    shutil.copyfile(source, temporary)
    with sqlite3.connect(temporary) as database:
        if database.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Sample database integrity check failed.")
    os.chmod(temporary, 0o600)
    os.link(temporary, target)
    os.unlink(temporary)
except FileExistsError:
    print(f"Database appeared at {target}; preserving it.")
    os.unlink(temporary)
except Exception:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
print(f"Installed sample database at {target}.")
PY
