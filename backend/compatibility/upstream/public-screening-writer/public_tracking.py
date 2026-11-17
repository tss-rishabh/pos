"""Selected public FastQueue capture; ordinary API calls keep their helper.

Read-only preparation emits no abandoned-cart notification. The two original
financial-boundary helpers retain their literal payload/queue calculation and
become captured postcommit obligations, not a direct broker client call.
"""
from pathlib import Path
from cart_tracking import compile_helper
from source_runtime import SilentLogger
from cart_preparation import PREVIEW_ONLY
from source_frame import FRAME
from writer_protocol import fail


def install(root,settings,modules,runtime_root=None):
    root=Path(root).resolve()
    names=('push_process_order_event','push_after_payment_event')
    # These are the exact ten source get_queue_name buckets. The independent
    # postcommit registry must still qualify durable publisher-confirm queues.
    captured=compile_helper(root,settings,tuple('user_cart_track_'+str(value) for value in range(10)),SilentLogger())
    runtime_root=Path(runtime_root or root).resolve()
    for module in modules:
        filename=getattr(module,'__file__',None)
        if not filename:continue
        try:inside=Path(filename).resolve().is_relative_to(runtime_root)
        except (OSError,ValueError):inside=False
        if not inside:continue
        for name in names:
            original=getattr(module,name,None)
            if not callable(original):continue
            def routed(*args,_original=original,_captured=captured[name],**kwargs):
                if FRAME.get() is None:return _original(*args,**kwargs)
                return _captured(*args,**kwargs)
            setattr(module,name,routed)
        original=getattr(module,'push_cart_event',None)
        if callable(original):
            def cart_event(*args,_original=original,**kwargs):
                if FRAME.get() is None:return _original(*args,**kwargs)
                if PREVIEW_ONLY.get():return None
                # This read-only helper is not part of PosOrder. No ambient
                # source flag authorizes an extra write/notification here.
                fail('SCREENING_CART_EFFECT_UNQUALIFIED')
            module.push_cart_event=cart_event
