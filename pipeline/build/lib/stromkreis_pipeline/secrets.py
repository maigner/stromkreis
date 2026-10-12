"""Entschluesselung der von der Plattform gespeicherten Secrets (Refresh-Tokens).

Format wie platform/src/lib/server/secrets.js: enc1:<iv b64>:<ciphertext+tag b64>,
AES-256-GCM, Schluessel TOKEN_SECRET (64 Hex-Zeichen) aus der Umgebung.
"""

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class SecretError(RuntimeError):
    pass


def _key():
    hex_key = os.environ.get("TOKEN_SECRET", "")
    if len(hex_key) != 64:
        raise SecretError("TOKEN_SECRET fehlt oder hat nicht 64 Hex-Zeichen")
    return bytes.fromhex(hex_key)


def decrypt(value):
    try:
        tag, iv_b64, ct_b64 = value.split(":")
    except ValueError as err:
        raise SecretError("Unbekanntes Chiffrat-Format") from err
    if tag != "enc1":
        raise SecretError("Unbekanntes Chiffrat-Format")
    return AESGCM(_key()).decrypt(base64.b64decode(iv_b64), base64.b64decode(ct_b64), None).decode()


def encrypt(plain):
    iv = os.urandom(12)
    ct = AESGCM(_key()).encrypt(iv, plain.encode(), None)
    return f"enc1:{base64.b64encode(iv).decode()}:{base64.b64encode(ct).decode()}"
