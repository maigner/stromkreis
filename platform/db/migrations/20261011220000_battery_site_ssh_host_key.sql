-- migrate:up

-- SSH-Host-Key (ed25519, OpenSSH-Form "ssh-ed25519 AAAA...") des Gateways
-- fuer die Fernwartung: das Gateway meldet ihn in der Phase "tunnel"
-- (08-install-wireguard.sh, authentifiziert mit dem Anlagen-Token), die
-- Plattform prueft ihn bei jeder SSH-Verbindung (gateway-ssh.js). Fehlt er
-- (Altbestand vor dieser Migration), uebernimmt die Plattform den Schluessel
-- der ersten Verbindung (TOFU). Befund S7 der Sicherheitspruefung 9/2026.
alter table battery_site add column ssh_host_key text;

-- migrate:down

alter table battery_site drop column ssh_host_key;
