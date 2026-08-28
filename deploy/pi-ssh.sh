#!/usr/bin/env bash
# Scriptgesteuertes SSH auf einen Test-Pi im LAN (vor dem WireGuard-Tunnel):
#   deploy/pi-ssh.sh <anlagen-id|host> [befehl ...]
# Ohne Befehl: interaktive Shell. Bei einer Anlagen-ID wird der Host
# stromkreis-<id>.local angenommen und das Anlagen-Passwort aus der DB am
# Server geholt; schlaegt es fehl, wird das openHABian-Standardpasswort
# probiert (gilt, solange die Erstinstallation noch laeuft).
set -euo pipefail
[ $# -ge 1 ] || { echo "Verwendung: $0 <anlagen-id|host> [befehl ...]"; exit 1; }
target="$1"; shift

if [[ "$target" =~ ^[0-9]+$ ]]; then
  host="stromkreis-${target}.local"
  pw="$(ssh server "cd /home/martin/Container/stromkreis && docker compose exec -T db psql -U stromkreis -d stromkreis -Atc \"select status->>'linux_password' from battery_site where id=${target}\"")"
else
  host="$target"
  pw="${STROMKREIS_PI_PASSWORD:-}"
fi

export PI_SSH_HOST="$host" PI_SSH_PW="$pw" PI_SSH_CMD="${*:-}"
exec python3 - <<'PY'
import os, sys, pexpect

host = os.environ["PI_SSH_HOST"]
cmd = os.environ["PI_SSH_CMD"]
passwords = [p for p in (os.environ.get("PI_SSH_PW", ""), "openhabian") if p]

argv = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=10", "-o", "PreferredAuthentications=password",
        f"openhabian@{host}"]
if cmd:
    # TTY erzwingen, damit sudo im Befehl nach dem Passwort fragen kann.
    argv.insert(0, "-tt")
    argv.append(cmd)

for pw in passwords:
    child = pexpect.spawn("ssh", argv, timeout=30, encoding="utf-8")
    i = child.expect(["assword:", pexpect.EOF, pexpect.TIMEOUT])
    if i != 0:
        print(child.before or "")
        print(f"FEHLER: keine Passwortabfrage von {host}.", file=sys.stderr)
        sys.exit(1)
    child.sendline(pw)
    # Kommt gleich wieder eine Login-Passwortabfrage, war das Passwort falsch;
    # eine sudo-Abfrage im laufenden Befehl bekommt dagegen dasselbe Passwort.
    while True:
        i = child.expect([r"\[sudo\] [Pp]assword", "assword:", pexpect.EOF, pexpect.TIMEOUT],
                         timeout=600 if cmd else 5)
        if i != 0:
            break
        child.sendline(pw)
    if i == 1:
        child.close()
        continue
    if cmd:
        print((child.before or "").replace("\r\n", "\n"), end="")
        sys.exit(child.exitstatus or 0)
    child.interact()
    sys.exit(0)

print(f"FEHLER: Anmeldung an {host} fehlgeschlagen (alle Passwoerter probiert).", file=sys.stderr)
sys.exit(1)
PY
