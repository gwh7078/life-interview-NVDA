#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=16) ? 0 : 1)'
}
if node_ok; then node --version; exit 0; fi

case "$(uname -m)" in
  aarch64|arm64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) die "Unsupported Node bootstrap architecture: $(uname -m)" ;;
esac

root="$SPARK_RUNTIME_DIR/tools"
install="$root/node"
tmp="$root/.node-download"
mkdir -p "$root" "$tmp"
manifest="$tmp/SHASUMS256.txt"
curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$manifest"
filename="$(awk -v a="linux-$arch.tar.xz" '$2 ~ a"$" {print $2; exit}' "$manifest")"
[[ -n "$filename" ]] || die "Could not resolve latest-v22.x archive for linux-$arch."
expected="$(awk -v f="$filename" '$2==f {print $1}' "$manifest")"
curl -fL --retry 3 "https://nodejs.org/dist/latest-v22.x/$filename" -o "$tmp/$filename"
printf '%s  %s\n' "$expected" "$tmp/$filename" | sha256sum -c -
rm -rf "$tmp/extract"
mkdir -p "$tmp/extract"
tar -xJf "$tmp/$filename" -C "$tmp/extract" --strip-components=1
rm -rf "$install.new"
mv "$tmp/extract" "$install.new"
rm -rf "$install"
mv "$install.new" "$install"
export PATH="$install/bin:$PATH"
node_ok || die "Node bootstrap completed but Node 22.16+ is still unavailable."
node --version
