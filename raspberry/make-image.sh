#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
IMAGES_DIR="$REPO_DIR/local/images"

PUBKEY="${1:-$HOME/.ssh/id_rsa.pub}"
SOURCE="${2:-$IMAGES_DIR/Move-Image-2.0.5.img}"
OUTPUT="${3:-$IMAGES_DIR/Move-Image-2.0.5-pi4.img}"
DEBUGFS=/opt/homebrew/opt/e2fsprogs/sbin/debugfs
E2FSCK=/opt/homebrew/opt/e2fsprogs/sbin/e2fsck
DATA_PARTITION=$(mktemp /private/tmp/move-data.XXXXXX)
KEYS=$(mktemp /private/tmp/move-keys.XXXXXX)

cleanup() {
  rm -f "$DATA_PARTITION" "$KEYS"
}
trap cleanup EXIT INT TERM

test -f "$SOURCE"
test -f "$PUBKEY"
test -x "$DEBUGFS"

if [ -e "$OUTPUT" ]; then
  echo "Refusing to overwrite existing file: $OUTPUT" >&2
  exit 1
fi

# Clone on APFS when possible; fall back to a regular copy.
cp -c "$SOURCE" "$OUTPUT" 2>/dev/null || cp "$SOURCE" "$OUTPUT"

# Partition 4 holds /data. Read its start/size (in 512-byte sectors) straight
# from the MBR table so this works across image versions without hard-coding
# offsets. fdisk prints the entry as: " 4: 83 ... [ <start> - <size> ] ...".
PART4=$(/usr/sbin/fdisk "$OUTPUT" 2>/dev/null | grep -E '^[* ]*4:' | head -n1)
PART4_RANGE=$(printf '%s\n' "$PART4" | sed -E 's/.*\[([^]]*)\].*/\1/')
PART4_START=$(printf '%s\n' "$PART4_RANGE" | awk '{print $1}')
PART4_SIZE=$(printf '%s\n' "$PART4_RANGE" | awk '{print $3}')

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
