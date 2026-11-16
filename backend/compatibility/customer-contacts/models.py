"""Explicit ORM projections; schemas/migrations are installed separately, never at HTTP startup."""

from sqlalchemy import JSON, BigInteger, Column, Integer, MetaData, String, Table, Text

metadata = MetaData()
receipts = Table(
    "pos_rewrite_customer_contact_effect_receipts",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("body_hash", String(64), nullable=False),
    Column("operation_id", String(36), nullable=False),
    Column("challenge_id", String(36), nullable=False),
    Column("operator_id", String(32), nullable=False),
    Column("customer_id", String(32), nullable=False),
    Column("request_id", String(128)),
    Column("status", String(16), nullable=False),
    Column("sealed_payload", Text, nullable=False),
    Column("created_at_ms", BigInteger, nullable=False),
)
jobs = Table(
    "pos_rewrite_customer_contact_effect_jobs",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("receipt_id", String(36), nullable=False),
    Column("kind", String(24), nullable=False),
    Column("position", Integer, nullable=False),
    Column("status", String(16), nullable=False),
    Column("sealed_payload", Text, nullable=False),
    Column("attempts", Integer, nullable=False),
    Column("lease_token", String(36)),
    Column("lease_expires_at_ms", BigInteger),
    Column("created_at_ms", BigInteger, nullable=False),
    Column("updated_at_ms", BigInteger, nullable=False),
)
node_challenges = Table(
    "pos_rewrite_customer_contact_challenges",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("checkout_id", String(36)),
    Column("operator_id", String(32)),
    Column("store_id", String(32)),
    Column("customer_id", String(32)),
    Column("kind", String(16)),
    Column("status", String(24)),
)
node_deliveries = Table(
    "pos_rewrite_customer_contact_deliveries",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("challenge_id", String(36)),
    Column("operator_id", String(32)),
    Column("customer_id", String(32)),
    Column("kind", String(24)),
    Column("status", String(16)),
)
node_mutations = Table(
    "pos_rewrite_customer_contact_mutations",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("challenge_id", String(36)),
    Column("operator_id", String(32)),
    Column("checkout_id", String(36)),
    Column("action", String(24)),
    Column("result", JSON),
)
users = Table(
    "users",
    metadata,
    Column("id", BigInteger, primary_key=True),
    Column("email", String(96)),
    Column("telephone", String(32)),
    Column("status", Integer),
    Column("is_block", Integer),
    Column("is_disabled", Integer),
    Column("is_two_fa", Integer),
)
orders = Table(
    "orders",
    metadata,
    Column("id", BigInteger, primary_key=True),
    Column("user_id", BigInteger),
)
alternatives = Table(
    "refund_alternate_payment_details",
    metadata,
    Column("id", BigInteger, primary_key=True),
    Column("order_id", BigInteger),
    Column("refund_request_id", BigInteger),
    Column("status", String(16)),
)
refunds = Table(
    "refund_requests",
    metadata,
    Column("id", BigInteger, primary_key=True),
    Column("is_completed", String(16)),
)
