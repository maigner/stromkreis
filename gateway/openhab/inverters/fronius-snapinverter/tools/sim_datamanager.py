#!/usr/bin/env python3
"""Modbus-TCP-Simulator fuer den Fronius Datamanager (SunSpec Model 124).

Stellt den Basic-Storage-Control-Block bereit, wie ihn das Profil
fronius-snapinverter erwartet (int + SF, Basisadresse 40313), und
protokolliert jeden Schreibzugriff auf stdout - damit laesst sich die
komplette IBM-Installation ohne Anlage testen:

    python3 sim_datamanager.py --port 5020

Braucht nur die Python-Standardbibliothek (kein pymodbus - dessen
Datastore-API hat sich zwischen 3.x-Versionen inkompatibel geaendert).
Unterstuetzt FC03/FC04 (Lesen), FC06/FC16 (Schreiben).

Vorgabewerte: SoC 55% (ChaState 5500, SF -2), WChaMax 5000 W (SF 0),
InWRte/OutWRte 100% (10000, SF -2), StorCtl_Mod 0, RvrtTms 0.
"""

import argparse
import datetime
import socketserver
import struct

M124_BASE = 40313

POINTS = {
    0: ("ID", 124),
    1: ("L", 24),
    2: ("WChaMax", 5000),
    3: ("WChaGra", 100),
    4: ("WDisChaGra", 100),
    5: ("StorCtl_Mod", 0),
    6: ("VAChaMax", 0),
    7: ("MinRsvPct", 500),
    8: ("ChaState", 5500),
    9: ("StorAval", 0),
    10: ("InBatV", 0),
    11: ("ChaSt", 3),
    12: ("OutWRte", 10000),
    13: ("InWRte", 10000),
    14: ("InOutWRte_WinTms", 0),
    15: ("InOutWRte_RvrtTms", 0),
    16: ("InOutWRte_RmpTms", 0),
    17: ("ChaGriSet", 0),
    18: ("WChaMax_SF", 0),
    19: ("WChaDisChaGra_SF", 0),
    20: ("VAChaMax_SF", 0),
    21: ("MinRsvPct_SF", 0xFFFE),   # -2 (int16, Zweierkomplement)
    22: ("ChaState_SF", 0xFFFE),    # -2
    23: ("StorAval_SF", 0),
    24: ("InBatV_SF", 0),
    25: ("InOutWRte_SF", 0xFFFE),   # -2
}

# Adressraum wie beim echten Datamanager grosszuegig mit Nullen fuellen,
# den Model-124-Block darueberlegen. Adressen sind 0-basiert, genau wie
# readStart/writeStart im openHAB-Modbus-Binding.
REGS = {addr: 0 for addr in range(40000, 40400)}
for _offset, (_, _value) in POINTS.items():
    REGS[M124_BASE + _offset] = _value


def point_name(address):
    offset = address - M124_BASE
    if offset in POINTS:
        return POINTS[offset][0]
    return "?"


def as_int16(value):
    return value - 0x10000 if value >= 0x8000 else value


def log_write(address, value):
    stamp = datetime.datetime.now().strftime("%H:%M:%S")
    print(f"[SIM] {stamp} WRITE {address} ({point_name(address)}) = "
          f"{value} (int16: {as_int16(int(value))})", flush=True)


def exception_pdu(fc, code):
    return struct.pack(">BB", fc | 0x80, code)


def process(pdu):
    """Verarbeitet eine Modbus-PDU und liefert die Antwort-PDU."""
    fc = pdu[0]
    if fc in (3, 4):  # Read Holding / Read Input Registers
        addr, count = struct.unpack(">HH", pdu[1:5])
        if count < 1 or count > 125:
            return exception_pdu(fc, 0x03)
        try:
            values = [REGS[a] for a in range(addr, addr + count)]
        except KeyError:
            return exception_pdu(fc, 0x02)
        return struct.pack(">BB", fc, count * 2) \
            + struct.pack(f">{count}H", *values)
    if fc == 6:  # Write Single Register
        addr, value = struct.unpack(">HH", pdu[1:5])
        if addr not in REGS:
            return exception_pdu(fc, 0x02)
        REGS[addr] = value
        log_write(addr, value)
        return pdu[:5]
    if fc == 16:  # Write Multiple Registers
        addr, count, nbytes = struct.unpack(">HHB", pdu[1:6])
        if count < 1 or count > 123 or nbytes != count * 2:
            return exception_pdu(fc, 0x03)
        if any(a not in REGS for a in range(addr, addr + count)):
            return exception_pdu(fc, 0x02)
        values = struct.unpack(f">{count}H", pdu[6:6 + nbytes])
        for i, value in enumerate(values):
            REGS[addr + i] = value
            log_write(addr + i, value)
        return struct.pack(">BHH", fc, addr, count)
    return exception_pdu(fc, 0x01)


def recvall(sock, n):
    data = b""
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            return None
        data += chunk
    return data


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        while True:
            header = recvall(self.request, 7)
            if header is None:
                return
            tid, _proto, length, unit = struct.unpack(">HHHB", header)
            pdu = recvall(self.request, length - 1)
            if pdu is None or not pdu:
                return
            resp = process(pdu)
            self.request.sendall(
                struct.pack(">HHHB", tid, 0, len(resp) + 1, unit) + resp)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5020,
                        help="TCP-Port (502 braucht root; Vorgabe 5020)")
    args = parser.parse_args()

    print(f"[SIM] Datamanager-Simulator auf {args.host}:{args.port}")
    print(f"[SIM] Model 124 ab Adresse {M124_BASE} (ID={POINTS[0][1]}, "
          f"WChaMax={POINTS[2][1]}, ChaState={POINTS[8][1]})", flush=True)
    with Server((args.host, args.port), Handler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
