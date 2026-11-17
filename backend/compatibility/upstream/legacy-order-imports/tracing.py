"""Only a verified private capability supplies an audit actor."""
from contextvars import ContextVar

TRUSTED_ACTOR=ContextVar('pos_import_verified_actor',default=None)
