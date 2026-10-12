#!/usr/bin/env python3
"""Fail-Safe-Reset fuer einen Deye-Niedervolt-Hybrid (TOU), ohne openHAB.

Schreibt das Werksverhalten der Anlage - Time of Use enable (146) = 0,
derselbe eine Write wie gwReset() in adapter.js - und prueft per Read-back,
dass das Register wirklich auf 0 steht. Die Anlage folgt danach wieder
ihrem Grundmodus (Eigenverbrauch); die Slot-Register (154-177) bleiben
unangetastet, sie wirken ohne aktiven Zeitplan nicht.

Wie der Adapter (__gwDyWrite, EEPROM-Schonung) wird NUR geschrieben, wenn
der Zeitplan tatsaechlich aktiv ist - steht 146 schon auf 0, ist der Reset
ohne Write bestaetigt. Das zaehlt, weil der Timer waehrend eines Ausfalls
alle FAILSAFE_REPEAT_MIN Minuten erneut aufruft.

Aufgerufen vom root-Timer stromkreis-failsafe (setup/10-install-failsafe.sh),
wenn openHAB keinen Heartbeat mehr schreibt oder nicht laeuft, und vom
Boot-Reset. Nur Standardbibliothek, eigener Modbus-TCP-Client (das Geraet
haengt hinter einem RS485-Ethernet-Gateway, Reads FC03, Writes FC06).

    failsafe_reset.py --host 192.168.1.50 [--port 502] [--unit 1]
    failsafe_reset.py --host 192.168.1.50 --reads     # nur lesen, nichts schreiben

Wie der Adapter schreibt das Skript nur, wenn das Geraet wie ein Deye der
3-phasigen Niedervolt-Familie antwortet: Work Mode (142) 0..2 und TOU
enable (146) 0..255. Besteht die Pruefung nicht, hat der Adapter dort auch
nie kommandiert - es gibt nichts zurueckzusetzen.

Exit 0  Reset bestaetigt (geschrieben oder schon im Werkszustand; bzw. --reads gelungen)
Exit 1  Gateway/Geraet nicht erreichbar oder Modbus-Fehler
Exit 2  Plausibilitaetspruefung nicht bestanden (nichts geschrieben)
Exit 3  Write angenommen, Read-back weicht ab
"""

import argparse
import socket
import struct
import sys
import time

# Registerkarte der 3-phasigen Niedervolt-Familie (literal, 0-basiert)
REG_BLOCK = 142      # 142..177: Work Mode, Max sell, Solar Sell, TOU, Slots
BLOCK_LEN = 36
OFF_WORK_MODE = 0    # 142
OFF_MAX_SELL = 1     # 143
OFF_SOLAR_SELL = 3   # 145
OFF_TOU_ENABLE = 4   # 146
OFF_SLOT_W = 12      # 154..159
OFF_SLOT_SOC = 24    # 166..171
OFF_SLOT_FLAG = 30   # 172..177
SLOT_COUNT = 6
REG_TOU_ENABLE = REG_BLOCK + OFF_TOU_ENABLE

# Werksverhalten: TOU-Zeitplan aus (DEYE_TOU_OFF im Adapter)
RESET_TOU = 0

# Plausibilitaetsfenster wie im Adapter (__gwDyGuard)
WORK_MODE_MAX = 2
TOU_MAX = 255

# Socket-Timeout: der Timer darf nie haengen. Kurze Pause zwischen den
# Requests, damit das RS485-Gateway den RTU-Umsatz schafft.
MODBUS_TIMEOUT_S = 5.0
REQUEST_PAUSE_S = 0.3


class ModbusError(Exception):
    CODES = {1: "Illegal function", 2: "Illegal data address",
             3: "Illegal data value", 4: "Slave device failure",
             10: "Gateway path unavailable", 11: "Gateway target failed"}

    def __init__(self, fc, code):
        name = self.CODES.get(code, f"Code {code}")
        super().__init__(f"Modbus-Exception auf FC{fc}: {name} (0x{code:02X})")


class Client:
    """Minimaler Modbus-TCP-Client: FC03 lesen, FC06 schreiben."""

    def __init__(self, host, port, unit):
        self.host, self.port, self.unit = host, port, unit
        self.sock = None
        self.tid = 0
        self.last_request = 0.0

    def connect(self):
        self.sock = socket.create_connection((self.host, self.port), timeout=MODBUS_TIMEOUT_S)
        self.sock.settimeout(MODBUS_TIMEOUT_S)

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def _recvall(self, n):
        data = b""
        while len(data) < n:
            chunk = self.sock.recv(n - len(data))
            if not chunk:
                raise ConnectionError("Verbindung geschlossen")
            data += chunk
        return data

    def _request(self, pdu):
        wait = REQUEST_PAUSE_S - (time.monotonic() - self.last_request)
        if wait > 0:
            time.sleep(wait)
        if self.sock is None:
            self.connect()
        self.tid = (self.tid + 1) % 0xFFFF
        self.sock.sendall(struct.pack(">HHHB", self.tid, 0, len(pdu) + 1, self.unit) + pdu)
        header = self._recvall(7)
        _tid, _proto, length, _unit = struct.unpack(">HHHB", header)
        resp = self._recvall(length - 1)
        self.last_request = time.monotonic()
        if resp[0] & 0x80:
            raise ModbusError(resp[0] & 0x7F, resp[1])
        return resp

    def read(self, address, count):
        resp = self._request(struct.pack(">BHH", 3, address, count))
        return list(struct.unpack(f">{count}H", resp[2:2 + count * 2]))

    def write(self, address, value):
        self._request(struct.pack(">BHH", 6, address, value & 0xFFFF))


def read_state(dev):
    block = dev.read(REG_BLOCK, BLOCK_LEN)
    return {
        "work_mode": block[OFF_WORK_MODE],
        "max_sell_w": block[OFF_MAX_SELL],
        "solar_sell": block[OFF_SOLAR_SELL],
        "tou": block[OFF_TOU_ENABLE],
        "slot_w": block[OFF_SLOT_W:OFF_SLOT_W + SLOT_COUNT],
        "slot_soc": block[OFF_SLOT_SOC:OFF_SLOT_SOC + SLOT_COUNT],
        "slot_flag": block[OFF_SLOT_FLAG:OFF_SLOT_FLAG + SLOT_COUNT],
    }


def guard_ok(state):
    return 0 <= state["work_mode"] <= WORK_MODE_MAX and 0 <= state["tou"] <= TOU_MAX


def slots(values):
    return "/".join(str(v) for v in values)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", required=True, help="IP des RS485-Ethernet-Gateways")
    parser.add_argument("--port", type=int, default=502)
    parser.add_argument("--unit", type=int, default=1,
                        help="Slave-ID des Wechselrichters am RS485-Bus (Vorgabe 1)")
    parser.add_argument("--reads", action="store_true",
                        help="nur die aktuellen Werte anzeigen, nichts schreiben")
    args = parser.parse_args()

    dev = Client(args.host, args.port, args.unit)
    written = False
    try:
        before = read_state(dev)
        if args.reads:
            print(f"Work Mode {before['work_mode']}, Max sell power {before['max_sell_w']} W,"
                  f" Solar Sell {before['solar_sell']}, TOU enable {before['tou']}")
            print(f"Slots Leistung {slots(before['slot_w'])} W, Ziel-SoC {slots(before['slot_soc'])}%,"
                  f" Flags {slots(before['slot_flag'])}"
                  f" (Plausibilitaet {'ok' if guard_ok(before) else 'NICHT bestanden'})")
            return 0

        if not guard_ok(before):
            print(f"keine Deye-Antwort (Work Mode {before['work_mode']}, TOU enable {before['tou']})"
                  f" - nichts geschrieben")
            return 2

        # Derselbe eine Write wie gwReset() im Adapter - nur bei Aenderung
        if before["tou"] != RESET_TOU:
            dev.write(REG_TOU_ENABLE, RESET_TOU)
            written = True
            after = read_state(dev)
        else:
            after = before
    except (OSError, ModbusError, ConnectionError) as e:
        print(f"{args.host}:{args.port} Unit {args.unit}: {e}")
        return 1
    finally:
        dev.close()

    ok = after["tou"] == RESET_TOU
    if written:
        print(f"vorher TOU enable {before['tou']} (Slots {slots(before['slot_w'])} W)"
              f" -> nachher TOU enable {after['tou']}"
              f" ({'bestaetigt' if ok else 'ABWEICHUNG'})")
    else:
        print(f"TOU enable bereits {after['tou']} - nichts geschrieben (bestaetigt)")
    return 0 if ok else 3


if __name__ == "__main__":
    sys.exit(main())
