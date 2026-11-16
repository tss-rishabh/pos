"""Bounded authenticated source-effect payload storage, separate from all POS/JWT keys."""

import base64
import hashlib
import hmac
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from contract import SECRET, ContactError, valid_uuid


class EffectCodec:
    def __init__(self, secret):
        if not isinstance(secret, str) or not SECRET.fullmatch(secret):
            raise ContactError("CONTACT_EFFECTS_CONFIGURATION_INVALID")
        self.key = hmac.new(
            secret.encode(), b"pos-contact-effect-storage:v1", hashlib.sha256
        ).digest()

    def seal(self, owner, value):
        if not valid_uuid(owner):
            raise ContactError("CONTACT_EFFECTS_PROOF_INVALID")
        raw = json.dumps(
            value, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode()
        if len(raw) > 256000:
            raise ContactError("CONTACT_EFFECTS_REQUEST_TOO_LARGE", 413)
        nonce = os.urandom(12)
        value = nonce + AESGCM(self.key).encrypt(
            nonce, raw, ("pos-contact-effect:" + owner).encode()
        )
        return base64.urlsafe_b64encode(value).decode()

    def open(self, owner, value):
        try:
            if (
                not valid_uuid(owner)
                or not isinstance(value, str)
                or not 40 <= len(value) <= 342000
            ):
                raise ValueError()
            raw = base64.b64decode(value, altchars=b"-_", validate=True)
            if not 29 <= len(raw) <= 256028:
                raise ValueError()
            decoded = AESGCM(self.key).decrypt(
                raw[:12], raw[12:], ("pos-contact-effect:" + owner).encode()
            )
            return json.loads(decoded)
        except Exception:
            raise ContactError("CONTACT_EFFECTS_STORAGE_INVALID") from None
