"""Generate/verify owned overlays. Never write protected source repositories."""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import sys

HERE=Path(__file__).resolve().parent
SOURCE=HERE.parents[4]/'backend-tss-api_v2'
sys.path.insert(0,str(HERE))
from native import HEADER
from source_runtime import PINS,checked_source


def once(value,old,new):
    if value.count(old)!=1:
        raise RuntimeError('Pinned composition boundary changed')
    return value.replace(old,new,1)


def outputs():
    for name in PINS:checked_source(SOURCE,name)
    base=HERE.parent/'go/internal/poscheckout'
    changes={}
    before=(base/'confirmation.go').read_text()
    after=once(before,'\titems, err := tx.QueryContext(ctx,',
        '\tlegacyImport, err := lockLegacyImport(ctx, tx, orderID, userID, storeID, counterID)\n\tif err != nil { return Confirmation{}, err }\n\titems, err := tx.QueryContext(ctx,')
    # The sole new-proof COMMIT follows the source proof insertion. Existing
    # proof replay never creates a second import confirmation receipt.
    marker='\tif err = tx.Commit(); err != nil {\n\t\treturn Confirmation{}, err\n\t}\n\treturn confirmation(true,'
    replacement='\tif err = recordLegacyImportConfirmation(ctx, tx, legacyImport, orderID); err != nil { return Confirmation{}, err }\n'+marker
    after=once(after,marker,replacement)
    changes['internal/poscheckout/confirmation.go']=(before,after)
    before=(base/'privacy.go').read_text()
    after=once(before,'\t\tconsentRaw := c.GetHeader("X-POS-Customer-Consent")',
        '\t\timportKey := c.GetHeader("X-POS-Legacy-Import-Key")\n\t\timportRaw := c.GetHeader("X-POS-Legacy-Import-Capability")\n\t\tc.Request.Header.Del("X-POS-Legacy-Import-Key")\n\t\tc.Request.Header.Del("X-POS-Legacy-Import-Capability")\n\t\tconsentRaw := c.GetHeader("X-POS-Customer-Consent")')
    after=once(after,'\t\tdefer func() {\n',
        '\t\tif importRaw != "" || importKey != "" {\n\t\t\tkey := ""\n\t\t\tif authorized && ProjectionKeyValid(env("POS_LEGACY_IMPORT_KEY"),importKey) { key = importKey }\n\t\t\tchecked,_ := WithLegacyImport(c.Request.Context(),importRaw,key,time.Now())\n\t\t\tc.Request = c.Request.WithContext(checked)\n\t\t}\n\t\tdefer func() {\n')
    changes['internal/poscheckout/privacy.go']=(before,after)
    before=(base/'effects.go').read_text()
    after=once(before,'\teffect.ID = fmt.Sprintf(',
        '\tvar imported int\n\tif err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM pos_rewrite_import_financial_order_bindings WHERE order_id=?`,fmt.Sprint(effect.OrderID)).Scan(&imported); err != nil { return err }\n\tif imported>0 && (effect.Resource=="order-producer" || effect.Resource=="order-engagement") { return nil }\n\teffect.ID = fmt.Sprintf(')
    after=once(after,"WHERE status='pending' AND resource IN (", "WHERE status='pending' AND NOT EXISTS(SELECT 1 FROM pos_rewrite_import_financial_order_bindings ib WHERE ib.order_id=CAST(pos_rewrite_checkout_projection_effects.order_id AS CHAR CHARACTER SET ascii) AND ib.status<>'completed') AND resource IN (")
    after=once(after,"\t\tif _, err = tx.ExecContext(ctx, `UPDATE pos_rewrite_checkout_projection_effects SET status='processing'",
        "\t\tif err = verifyLegacyImportEffect(ctx,tx,effect); err != nil { tx.Rollback(); return err }\n\t\tif _, err = tx.ExecContext(ctx, `UPDATE pos_rewrite_checkout_projection_effects SET status='processing'")
    changes['internal/poscheckout/effects.go']=(before,after)
    helper=(HERE/'legacy_import.go').read_text()+'\nconst LegacyImportHeaderSQL = '+json.dumps(HEADER)+'\n'
    changes['internal/poscheckout/legacy_import.go']=('',helper)
    patch=''.join(''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+path if old else '/dev/null',tofile='b/'+path)) for path,(old,new) in changes.items())
    public_main=(SOURCE/'main.py').read_text()
    guarded_main=once(public_main,'middleware = [DatabaseManager(',
        'from middleware.PosImportOrderGuard import ImportOrderGuard\n\nmiddleware = [DatabaseManager(')
    guarded_main=once(guarded_main,'MultipartMiddleware(), ActiveCartMiddleware()]',
        'MultipartMiddleware(), ActiveCartMiddleware(), ImportOrderGuard()]')
    public_changes={'main.py':(public_main,guarded_main),'middleware/PosImportOrderGuard.py':('',(HERE/'order_guard.py').read_text())}
    public_patch=''.join(''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+path if old else '/dev/null',tofile='b/'+path)) for path,(old,new) in public_changes.items())
    source_paths=['models/Order.py','libs/OrderHelper.py','controllers/CheckoutController.py','controllers/CatalogController.py','controllers/KinesisProducer.py','main.py']
    manifest={'paymentsCommit':'434f3e438d1cb48c64e5723222c6efda506db571',
        'sourceCommit':'2960acbea10c4eaf16b6d99e15ff6e03ef7724c5','contract':'pos-legacy-order-import-confirmation-v1',
        'activated':False,'base':{path:hashlib.sha256(old.encode()).hexdigest() for path,(old,_) in changes.items() if old},
        'candidate':{path:hashlib.sha256(new.encode()).hexdigest() for path,(_,new) in changes.items()},
        'patchSha256':hashlib.sha256(patch.encode()).hexdigest(),
        'apiGuardPatchSha256':hashlib.sha256(public_patch.encode()).hexdigest(),
        'apiGuardBaseSha256':hashlib.sha256(public_main.encode()).hexdigest(),
        'sourceFiles':{path:hashlib.sha256((SOURCE/path).read_bytes()).hexdigest() for path in source_paths},
        'modelContract':'pos-import-source-model-v1',
        'membership':{'contract':'pos-legacy-import-membership-v1','activated':False,
            'stagedContract':'pos-cancellation-membership-staged-v2',
            'activatedContract':'pos-cancellation-membership-provenance-v2',
            'historyContract':'pos-csv-membership-history-v1',
            'files':{name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in (
                'membership_profile.py','membership_history.py','membership_cache.py','membership_consumer.py',
                'source_runtime.py','profiles.py','native.py','receiver.py','effects.py','runtime.py')},
            'sourceFiles':__import__('membership_profile').PINS,
            'ordinaryProducerSha256':hashlib.sha256((HERE.parent/'pending-cancellation/membership_provenance.py').read_bytes()).hexdigest()}}
    return {HERE/'payments-import-overlay.patch':patch,HERE/'api-import-guard.patch':public_patch,HERE/'manifest.json':json.dumps(manifest,indent=2)+'\n'}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--write',action='store_true');args=parser.parse_args()
    for path,value in outputs().items():
        if args.write:path.write_text(value)
        elif not path.exists() or path.read_text()!=value:raise RuntimeError('Owned import overlay differs: '+path.name)
        print(path.name+' '+hashlib.sha256(value.encode()).hexdigest())
