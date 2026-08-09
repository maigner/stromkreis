"""Mandanten-Konfiguration fuer den EEG-Faktura-Import.

Nicht-Geheimes je Mandant liegt in der Tabelle eegfaktura_source, Secrets nur
in der Umgebung (Server-.env): EEGFAKTURA_<SLUG>_USER / _PASSWORD fuer
auth_mode basic, EEGFAKTURA_<SLUG>_CLIENT_ID / _CLIENT_SECRET fuer
client_credentials. <SLUG> ist der Tenant-Slug grossgeschrieben, '-' als '_'.
"""

import os
from dataclasses import dataclass

from .client import BasicAuth, ClientCredentialsAuth

DEFAULT_TOKEN_URL = "https://login.eegfaktura.at/realms/EEGFaktura/protocol/openid-connect/token"


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class TenantSource:
    tenant_id: int
    slug: str
    rc_number: str
    base_url: str
    auth_mode: str  # 'basic' | 'client_credentials'
    token_url: str | None
    active: bool


def load_sources(conn, slug=None):
    """Aktive Import-Konfigurationen laden; mit slug genau einen Mandanten
    (dann auch inaktive, fuer manuelle Laeufe)."""
    query = """
        select s.tenant_id, t.slug, s.rc_number, s.base_url, s.auth_mode, s.token_url, s.active
        from eegfaktura_source s
        join tenant t on t.id = s.tenant_id
    """
    params = ()
    if slug is not None:
        query += " where t.slug = %s"
        params = (slug,)
    else:
        query += " where s.active"
    query += " order by t.slug"
    with conn.cursor() as cur:
        cur.execute(query, params)
        rows = cur.fetchall()
    sources = [TenantSource(*row) for row in rows]
    if slug is not None and not sources:
        raise ConfigError(f"Kein eegfaktura_source-Eintrag fuer Mandant '{slug}'")
    return sources


def _env_key(slug, name):
    return f"EEGFAKTURA_{slug.upper().replace('-', '_')}_{name}"


def _require_env(slug, name):
    key = _env_key(slug, name)
    value = os.environ.get(key)
    if not value:
        raise ConfigError(f"Umgebungsvariable {key} fehlt")
    return value


def build_auth(source):
    """Auth-Strategie fuer einen Mandanten aus der Umgebung bauen."""
    if source.auth_mode == "basic":
        return BasicAuth(
            _require_env(source.slug, "USER"),
            _require_env(source.slug, "PASSWORD"),
        )
    if source.auth_mode == "client_credentials":
        return ClientCredentialsAuth(
            source.token_url or DEFAULT_TOKEN_URL,
            _require_env(source.slug, "CLIENT_ID"),
            _require_env(source.slug, "CLIENT_SECRET"),
        )
    raise ConfigError(f"Unbekannter auth_mode: {source.auth_mode}")
