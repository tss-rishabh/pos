"""Dedicated source-process Beaker policy for the nonpersisted owned cart.

Actual decorated functions run against the current private transaction. Redis
warming/invalidation cannot escape a rollback-only preview or an uncommitted
order. Explicit postcommit invalidation tasks keep the original Beaker port.
"""
import ast
import functools
import hashlib
import importlib
from pathlib import Path
from protocol import ImportReview
from transaction import CURRENT

SOURCE_SHA='9ff6d13111aad06f29159768b631fc4757f7ad6a0a21dd229303c5afa78b9bc7'


def configure(root,settings,cache=None):
    cache=cache or importlib.import_module('beaker.cache')
    root=Path(root).resolve()
    marker=getattr(cache,'__pos_private_cache__',None)
    if marker is not None:
        if marker!=str(root):raise ImportReview('ORDER_IMPORT_PRIVATE_SCOPE_REQUIRED')
        return
    raw=(root/'main.py').read_bytes()
    if hashlib.sha256(raw).hexdigest()!=SOURCE_SHA:raise ImportReview('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
    tree=ast.parse(raw)
    updates=[node for node in tree.body if isinstance(node,ast.Expr) and isinstance(node.value,ast.Call)
             and ast.unparse(node.value.func)=='cache_regions.update']
    if len(updates)!=1:raise ImportReview('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
    # Only the pinned cache declaration, never source main/HTTP/middleware.
    exec(compile(ast.Module(body=updates,type_ignores=[]),'<pinned-private-cache-regions>','exec'),
         {'cache_regions':cache.cache_regions,'settings':settings})
    original_decorator=cache.cache_region;original_invalidate=cache.region_invalidate
    def cache_region(*args,**kwargs):
        original=original_decorator(*args,**kwargs)
        def decorate(function):
            external=original(function)
            @functools.wraps(external)
            def current(*values,**named):
                if CURRENT.get() is None:
                    raise ImportReview('ORDER_IMPORT_PRIVATE_SCOPE_REQUIRED')
                # Execute real source body. No cached absence, stale contact,
                # get/set or distributed lock becomes transaction authority.
                return function(*values,**named)
            return current
        return decorate
    def region_invalidate(*args,**kwargs):
        if CURRENT.get() is not None:return None
        return original_invalidate(*args,**kwargs)
    cache.cache_region=cache_region;cache.region_invalidate=region_invalidate
    cache.__pos_private_cache__=str(root)
