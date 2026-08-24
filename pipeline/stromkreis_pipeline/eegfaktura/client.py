"""HTTP-Client fuer die EEG-Faktura-API (energystore + backend).

Zwei Auth-Strategien (siehe docs/eegfaktura-api.md):

- BasicAuth: Portal-Zugangsdaten als "Authorization: Basic ...". Der Server
  dekodiert URL-safe Base64, Python-Bibliotheken kodieren standard; der Header
  wird deshalb hier selbst mit base64.urlsafe_b64encode gebaut.
- ClientCredentialsAuth: Token vom Keycloak per client_credentials
  (Client-ID/Secret im Authorization-Header, nicht im Body), ca. 5 Minuten
  gueltig, wird gecacht und kurz vor Ablauf erneuert.

Zeitparameter der API sind Unix-Millisekunden; nach aussen gibt es nur
aware datetime, die Umrechnung passiert an der HTTP-Grenze.
"""

import base64
import time
from datetime import datetime, timezone

import requests

TIMEOUT = 120  # Sekunden; v1 liest serverseitig die ganze Range, das dauert
TOKEN_LEEWAY = 30  # Sekunden vor Ablauf erneuern
DEFAULT_TOKEN_EXPIRES = 300  # falls die Token-Antwort kein expires_in traegt


class EegfakturaError(RuntimeError):
    """Fehlerantwort der EEG-Faktura-API oder des Keycloak."""

    def __init__(self, message, status=None, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


def to_ms(dt):
    """Aware datetime zu Unix-Millisekunden."""
    if dt.tzinfo is None:
        raise ValueError("naive datetime; Zeitpunkte muessen eine Zeitzone tragen")
    return int(dt.timestamp() * 1000)


def from_ms(ms):
    """Unix-Millisekunden zu aware datetime in UTC."""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


class BasicAuth:
    """Portal-Zugangsdaten, serverseitiger Passwort-Tausch (ProtectApi).

    Die beiden Dienste dekodieren den Header unterschiedlich: energystore
    (/energystore/*) mit URL-safe Base64, backend (/api/*) mit Standard-Base64.
    Die Varianten unterscheiden sich nur in '+'/'/' bzw. '-'/'_'; damit auch
    Zugangsdaten mit solchen Zeichen ueberall funktionieren, wird je Pfad kodiert.
    """

    def __init__(self, username, password):
        raw = f"{username}:{password}".encode()
        self._urlsafe = "Basic " + base64.urlsafe_b64encode(raw).decode()
        self._standard = "Basic " + base64.b64encode(raw).decode()

    def headers(self, path="/energystore/"):
        header = self._standard if path.startswith("/api/") else self._urlsafe
        return {"Authorization": header}

    def invalidate(self):
        pass  # kein Zustand


class ClientCredentialsAuth:
    """Keycloak-Token per client_credentials, gecacht bis kurz vor Ablauf."""

    def __init__(self, token_url, client_id, client_secret, session=None):
        self.token_url = token_url
        self.client_id = client_id
        self.client_secret = client_secret
        self.session = session or requests.Session()
        self._token = None
        self._expires_at = 0.0  # time.monotonic()

    def headers(self, path=None):
        if self._token is None or time.monotonic() >= self._expires_at:
            self._fetch()
        return {"Authorization": f"Bearer {self._token}"}

    def invalidate(self):
        self._token = None

    def _fetch(self):
        try:
            resp = self.session.post(
                self.token_url,
                data={"grant_type": "client_credentials"},
                auth=(self.client_id, self.client_secret),
                timeout=TIMEOUT,
            )
        except requests.RequestException as err:
            raise EegfakturaError(f"Keycloak nicht erreichbar: {err}") from err
        if resp.status_code != 200:
            raise EegfakturaError(
                f"Token-Anfrage fehlgeschlagen (HTTP {resp.status_code})",
                status=resp.status_code,
                body=resp.text[:500],
            )
        payload = resp.json()
        self._token = payload["access_token"]
        expires_in = payload.get("expires_in", DEFAULT_TOKEN_EXPIRES)
        self._expires_at = time.monotonic() + max(expires_in - TOKEN_LEEWAY, 5)


class EegfakturaClient:
    """Zugriff auf die drei Maschinen-Endpunkte einer EEG-Faktura-Instanz."""

    def __init__(self, base_url, rc_number, auth, session=None, ec_id=None):
        self.base_url = base_url.rstrip("/")
        self.rc_number = rc_number.upper()  # Server vergleicht grossgeschrieben
        # ecId der Energiedaten-Endpunkte: die Gemeinschafts-ID (AT..., 33 Zeichen).
        # Der energystore speichert je <tenant>/<ecId>; ohne Angabe RC-Nummer
        # (alte Annahme aus docs/eegfaktura-api.md, liefert bei EEG-Faktura leere Antworten).
        self.ec_id = (ec_id or rc_number).upper()
        self.auth = auth
        self.session = session or requests.Session()

    def _request(self, method, path, json_body=None):
        url = self.base_url + path
        try:
            headers = {"X-Tenant": self.rc_number, **self.auth.headers(path)}
            resp = self.session.request(method, url, json=json_body, headers=headers, timeout=TIMEOUT)
            if resp.status_code in (401, 403):
                # Einmal mit frischer Auth wiederholen (Token abgelaufen o.ae.)
                self.auth.invalidate()
                headers = {"X-Tenant": self.rc_number, **self.auth.headers(path)}
                resp = self.session.request(method, url, json=json_body, headers=headers, timeout=TIMEOUT)
        except requests.RequestException as err:
            raise EegfakturaError(f"{method} {path}: API nicht erreichbar: {err}") from err
        if resp.status_code not in (200, 201):
            raise EegfakturaError(
                f"{method} {path} fehlgeschlagen (HTTP {resp.status_code})",
                status=resp.status_code,
                body=resp.text[:500],
            )
        return resp.json()

    def metadata(self):
        """Verfuegbarer Zeitraum. Rueckgabe (period_begin, period_end) in UTC.

        Die API liefert je nach Version ein flaches Objekt oder eine Map je
        Zaehlpunkt; hier wird beides akzeptiert und auf min/max reduziert.
        """
        payload = self._request("POST", f"/energystore/query/{self.ec_id}/metadata", json_body={})
        entries = []
        if isinstance(payload, dict):
            if "periodBegin" in payload:
                entries = [payload]
            else:
                entries = [v for v in payload.values() if isinstance(v, dict) and "periodBegin" in v]
        begins = [e["periodBegin"] for e in entries if e.get("periodBegin")]
        ends = [e["periodEnd"] for e in entries if e.get("periodEnd")]
        if not begins or not ends:
            raise EegfakturaError("metadata ohne periodBegin/periodEnd", body=str(payload)[:500])
        return from_ms(min(begins)), from_ms(max(ends))

    def rawdata(self, start, end, metering_points=None):
        """15-Minuten-Rohdaten im Zeitraum [start, end].

        Rueckgabe wie geliefert: Map Zaehlpunkt zu {direction, data: [...]}.
        Ohne metering_points loest der Server alle aktiven Zaehlpunkte auf.
        """
        body = {
            "ecId": self.ec_id,
            "start": to_ms(start),
            "end": to_ms(end),
        }
        if metering_points:
            body["cps"] = [{"meteringPoint": mp} for mp in metering_points]
        payload = self._request("POST", "/energystore/query/rawdata", json_body=body)
        if not isinstance(payload, dict):
            raise EegfakturaError("rawdata: unerwartete Antwortform", body=str(payload)[:500])
        return payload

    def masterdata(self):
        """Teilnehmerliste mit Zaehlpunkten (backend, /api/master/masterdata)."""
        payload = self._request("GET", "/api/master/masterdata")
        if not isinstance(payload, list):
            raise EegfakturaError("masterdata: unerwartete Antwortform", body=str(payload)[:500])
        return payload
