#!/usr/bin/env bash
# Native release assets verified against release API digests and checksums.txt.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo 'Usage: install-supabase-cli-ci.sh <reviewed-version>' >&2
  exit 2
fi
version="$1"
case "${version}:$(uname -s):$(uname -m)" in
  2.122.0:Linux:x86_64)
    asset_id=668850237
    expected_sha=59ed066847b98d7461c60e9109d40cab6b9756177ce06ebb05b51338519f5136
    ;;
  2.122.0:Darwin:arm64)
    asset_id=668849778
    expected_sha=fe87a5f9781d5423dbd5ebba2d5a6e1a541d01754d14941c574952e5695eaab0
    ;;
  *)
    echo "No reviewed Supabase CLI asset for ${version} on $(uname -s)/$(uname -m)" >&2
    exit 2
    ;;
esac

temp_root="${RUNNER_TEMP:-${TMPDIR:-}}"
if [ -n "$temp_root" ]; then
  install_dir="$(mktemp -d "$temp_root/openlup-supabase-cli.XXXXXX")"
else
  install_dir="$(mktemp -d)"
fi
install_dir="$(cd "$install_dir" && pwd -P)"
trap 'rm -rf "$install_dir"' EXIT
archive="$install_dir/cli.tar.gz"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --fail --location --silent --show-error --retry 2 --retry-all-errors \
  --connect-timeout 15 --max-time 120 --header 'Accept: application/octet-stream' \
  "https://api.github.com/repos/supabase/cli/releases/assets/${asset_id}" --output "$archive"
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha="$(sha256sum "$archive" | awk '{print $1}')"
else
  actual_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
fi
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "Supabase CLI archive checksum mismatch: expected ${expected_sha}, got ${actual_sha}" >&2
  exit 1
fi
# Extract only the verified executable, never the archive's other entries.
tar -xzf "$archive" -C "$install_dir" supabase
chmod 755 "$install_dir/supabase"
actual_version="$("$install_dir/supabase" --version)"
if [ "$actual_version" != "$version" ]; then
  echo "Supabase CLI version mismatch: expected ${version}, got ${actual_version}" >&2
  exit 1
fi
rm "$archive"
if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$install_dir" >> "$GITHUB_PATH"
fi
printf '%s\n' "$install_dir"
trap - EXIT
