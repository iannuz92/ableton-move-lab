#!/usr/bin/env python3
from __future__ import annotations

import os
import signal
import subprocess
import time
from pathlib import Path


ROOT = Path("/emulator")
INPUT = ROOT / "input" / "midi.bin"
SPI = ROOT / "spi"
TX_PACKETS = SPI / "tx-packets.bin"


def packet_records(path: Path) -> list[bytes]:
    if not path.exists():
        return []
    data = path.read_bytes()
    records: list[bytes] = []
    offset = 0
    while offset + 24 <= len(data):
        length = int.from_bytes(data[offset + 16 : offset + 20], "little")
        start = offset + 24
        end = start + length
        if end > len(data):
            break
        records.append(data[start:end])
        offset = end
    return records


def interesting(records: list[bytes]) -> list[tuple[int, list[tuple[int, bytes]]]]:
    found: list[tuple[int, list[tuple[int, bytes]]]] = []
    for record_index, record in enumerate(records):
        quads = [(i, record[i : i + 4]) for i in range(0, len(record), 4) if any(record[i : i + 4])]
        if record_index == 0 and quads == [
            (0, bytes.fromhex("fb b0 00 02")),
            (4, bytes.fromhex("fb b0 01 40")),
            (8, bytes.fromhex("0f ff 00 00")),
        ]:
            continue
        if quads:
            found.append((record_index, quads[:16]))
    return found


def run_candidate(name: str, payload: bytes, seconds: float = 0.85) -> tuple[int, list[tuple[int, list[tuple[int, bytes]]]]]:
    INPUT.write_bytes(payload)
    for child in SPI.iterdir():
        child.unlink()

    env = os.environ.copy()
    env["MOVE_XMOS_SCRIPT"] = "off"
    env["MOVE_XMOS_CAPTURE_RX"] = "0"
    env["LD_PRELOAD"] = "/emulator/libablspi_shim.so"

    process = subprocess.Popen(
        [
            "/opt/move/MoveMessageDisplay",
            "--message",
            name,
            "--log-level",
            "error",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    time.sleep(seconds)
    try:
        process.send_signal(signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=2)
    records = packet_records(TX_PACKETS)
    return len(records), interesting(records)


def make_payload(packet: bytes, repeats: int = 12) -> bytes:
    return packet * repeats


def main() -> int:
    (ROOT / "input").mkdir(parents=True, exist_ok=True)
    SPI.mkdir(parents=True, exist_ok=True)

    candidates: list[tuple[str, bytes]] = []
    for cable in (0x00, 0xF0):
        tag = f"cable{cable >> 4}"
        for value in range(0, 8):
            candidates.append((f"{tag}-f1-{value}", bytes([cable | 0x0F, 0xF1, value, 0x00])))
            candidates.append((f"{tag}-f2-{value}", bytes([cable | 0x0F, 0xF2, value, 0x00])))
            candidates.append((f"{tag}-f3-{value}", bytes([cable | 0x0F, 0xF3, value, 0x00])))
        for status in range(0xF6, 0x100):
            candidates.append((f"{tag}-rt-{status:02x}", bytes([cable | 0x0F, status, 0x00, 0x00])))
        if os.environ.get("FUZZ_CC") == "1":
            for controller in range(0x00, 0x10):
                for value in range(0, 8):
                    candidates.append((f"{tag}-cc-{controller:02x}-{value}", bytes([cable | 0x0B, 0xB0, controller, value])))

    hits = []
    for index, (name, packet) in enumerate(candidates, start=1):
        records, found = run_candidate(name, make_payload(packet))
        if found or records > 2:
            hits.append((name, packet, records, found))
            print(f"HIT {name} packet={packet.hex(' ')} records={records}")
            for record_index, quads in found[:4]:
                compact = " ".join(f"@{offset:03x}:{chunk.hex()}" for offset, chunk in quads[:8])
                print(f"  rec={record_index} {compact}")
        elif index % 25 == 0:
            print(f"tested {index}/{len(candidates)}")

    print(f"done candidates={len(candidates)} hits={len(hits)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
