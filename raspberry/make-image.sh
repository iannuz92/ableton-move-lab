#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
IMAGES_DIR="$REPO_DIR/local/images"

PUBKEY="${1:-$HOME/.ssh/id_rsa.pub}"
SOURCE="${2:-$IMAGES_DIR/Move-Image-2.0.5.img}"
OUTPUT="${3:-$IMAGES_DIR/Move-Image-2.0.5-pi4.img}"
DEBUGFS="${DEBUGFS:-}"
E2FSCK="${E2FSCK:-}"
TMPDIR="${TMPDIR:-/tmp}"
DATA_PARTITION=$(mktemp "$TMPDIR/move-data.XXXXXX")
KEYS=$(mktemp "$TMPDIR/move-keys.XXXXXX")

cleanup() {
  rm -f "$DATA_PARTITION" "$KEYS"
}
trap cleanup EXIT INT TERM

find_tool() {
  var_value="$1"
  tool_name="$2"
  homebrew_path="$3"
  if [ -n "$var_value" ]; then
    printf '%s\n' "$var_value"
  elif command -v "$tool_name" >/dev/null 2>&1; then
    command -v "$tool_name"
  elif [ -x "$homebrew_path" ]; then
    printf '%s\n' "$homebrew_path"
  else
    return 1
  fi
}

fdisk_output() {
  fdisk -l "$OUTPUT" 2>/dev/null || fdisk "$OUTPUT" 2>/dev/null
}

partition_start_size() {
  fdisk_output | awk -v part="$1" '
    $1 ~ "^[* ]*" part ":" {
      for (i = 1; i <= NF; i += 1) {
        if ($i == "[") { print $(i + 1), $(i + 3); exit }
        if ($i ~ /^\[/) {
          start = $i
          gsub(/^\[/, "", start)
          print start, $(i + 2)
          exit
        }
      }
    }
    $1 ~ "p?" part "$" {
      if ($2 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/) { print $2, $4; exit }
    }
  '
}

test -f "$SOURCE"
test -f "$PUBKEY"
DEBUGFS="$(find_tool "$DEBUGFS" debugfs /opt/homebrew/opt/e2fsprogs/sbin/debugfs)" || { echo "debugfs not found. Install e2fsprogs." >&2; exit 1; }
E2FSCK="$(find_tool "$E2FSCK" e2fsck /opt/homebrew/opt/e2fsprogs/sbin/e2fsck)" || { echo "e2fsck not found. Install e2fsprogs." >&2; exit 1; }

if [ -e "$OUTPUT" ]; then
  echo "Refusing to overwrite existing file: $OUTPUT" >&2
  exit 1
fi

# Clone on APFS when possible; fall back to a regular copy.
cp -c "$SOURCE" "$OUTPUT" 2>/dev/null || cp "$SOURCE" "$OUTPUT"

# Partition 4 holds /data. Read its start/size (in 512-byte sectors) straight
# from the MBR table so this works across image versions without hard-coding
# offsets. Supports both macOS fdisk and Linux fdisk output.
set -- $(partition_start_size 4)
PART4_START="${1:-}"
PART4_SIZE="${2:-}"

case "$PART4_START$PART4_SIZE" in
  ''|*[!0-9]*)
    echo "Could not parse partition 4 from $OUTPUT" >&2
    exit 1
    ;;
esac
echo "Partition 4 (/data): start=$PART4_START size=$PART4_SIZE sectors (512-byte)"

dd if="$OUTPUT" of="$DATA_PARTITION" bs=512 skip="$PART4_START" count="$PART4_SIZE"
"$DEBUGFS" -R "dump /authorized_keys $KEYS" "$DATA_PARTITION" || true

if ! grep -qxFf "$PUBKEY" "$KEYS"; then
  printf '\n' >> "$KEYS"
  sed -n '1p' "$PUBKEY" >> "$KEYS"
fi

"$DEBUGFS" -w -R "rm /authorized_keys" "$DATA_PARTITION"
"$DEBUGFS" -w -R "write $KEYS /authorized_keys" "$DATA_PARTITION"
"$DEBUGFS" -w -R "set_inode_field /authorized_keys mode 0100600" "$DATA_PARTITION"
"$DEBUGFS" -w -R "set_inode_field /authorized_keys uid 0" "$DATA_PARTITION"
"$DEBUGFS" -w -R "set_inode_field /authorized_keys gid 0" "$DATA_PARTITION"
"$E2FSCK" -fn "$DATA_PARTITION"

dd if="$DATA_PARTITION" of="$OUTPUT" bs=512 seek="$PART4_START" conv=notrunc
shasum -a 256 "$OUTPUT"
echo "Pi-ready image: $OUTPUT"
