#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/lib/common.sh"

node_ok() {
  [[ -x "$1" ]] || return 1
  [[ "$("$1" --version)" == "v$SPARK_NODE_VERSION" ]] || return 1
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a===24 && b>=16) || (a===26 && b>=1) || a>26 ? 0 : 1)'
}
node="$SPARK_HOME/tools/node/bin/node"
if node_ok "$node"; then "$node" --version; exit 0; fi

case "$(uname -m)" in
  aarch64|arm64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) die "Unsupported Node bootstrap architecture: $(uname -m)" ;;
esac

version="$SPARK_NODE_VERSION"
root="$SPARK_HOME/tools"
install="$root/node"
tmp="$root/.node-download"
mkdir -p "$root" "$tmp"
manifest="$tmp/SHASUMS256.txt"
curl -fsSL "https://nodejs.org/dist/v$version/SHASUMS256.txt" -o "$manifest"
filename="$(awk -v a="linux-$arch.tar.xz" '$2 ~ a"$" {print $2; exit}' "$manifest")"
[[ -n "$filename" ]] || die "Could not resolve Node $version archive for linux-$arch."
expected="$(awk -v f="$filename" '$2==f {print $1}' "$manifest")"
curl -fL --retry 3 "https://nodejs.org/dist/v$version/$filename" -o "$tmp/$filename"
printf '%s  %s\n' "$expected" "$tmp/$filename" | sha256sum -c -
rm -rf "$tmp/extract"
mkdir -p "$tmp/extract"
tar -xJf "$tmp/$filename" -C "$tmp/extract" --strip-components=1
rm -rf "$install.new"
mv "$tmp/extract" "$install.new"
if [[ -d "$install" ]]; then mv "$install" "$install.old"; fi
mv "$install.new" "$install"
rm -rf "$install.old"
export PATH="$install/bin:$PATH"
node_ok "$install/bin/node" || die "Node bootstrap completed but a project-compatible Node runtime is still unavailable."
"$install/bin/node" --version
