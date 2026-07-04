#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CC="${CC:-}"
READELF="${READELF:-}"

if [ -z "$CC" ]; then
  if command -v aarch64-linux-gnu-gcc >/dev/null 2>&1; then
    CC=aarch64-linux-gnu-gcc
  elif [ "$(uname -m)" = "aarch64" ] || [ "$(uname -m)" = "arm64" ]; then
    CC=gcc
  else
    echo "Missing ARM64 compiler." >&2
    echo "Install aarch64-linux-gnu-gcc, or run this script on the Raspberry Pi." >&2
    exit 1
  fi
fi

if [ -z "$READELF" ]; then
  if command -v aarch64-linux-gnu-readelf >/dev/null 2>&1; then
    READELF=aarch64-linux-gnu-readelf
  else
    READELF=readelf
  fi
fi

cd "$SCRIPT_DIR"
"$CC" -O2 -Wall -Wextra -shared -fPIC \
  -o libablspi_shim.so shim/ablspi_shim.c -ldl -pthread
"$READELF" -h libablspi_shim.so | sed -n "1,12p"
