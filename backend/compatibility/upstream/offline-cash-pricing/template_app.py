"""Private receipt-only source constructor resource; no caller-supplied prices."""

from __future__ import annotations

import uuid

from app import create_private_resource
from pricing_service import freeze_settings
from source_calculator import PricingError
from source_template import build_template

PATH = "/internal/pos/offline-cash/import-template"


def create_template_app(
    source_root,
    settings,
    session_factory,
    service_key,
    *,
    business_timezone="Asia/Kolkata",
    emit=lambda _event: None,
):
    frozen = freeze_settings(settings)

    def handle(body, _operator):
        try:
            if not isinstance(body, dict) or set(body) != {"receiptId"}:
                raise ValueError()
            receipt_id = body["receiptId"]
            if str(uuid.UUID(receipt_id)) != receipt_id:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise PricingError("INVALID_REQUEST", 400) from None
        with session_factory() as executor:
            return build_template(
                source_root, frozen, executor, receipt_id, business_timezone
            )

    return create_private_resource(
        PATH, service_key, handle, emit=emit, resource="offline-cash-import-template"
    )
