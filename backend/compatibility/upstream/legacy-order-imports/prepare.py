"""Generate/verify owned overlays. Never write protected source repositories."""
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path
import sys

HERE=Path(__file__).resolve().parent
SOURCE=Path(os.environ.get('POS_LEGACY_IMPORT_SOURCE_ROOT',str(HERE.parents[4]/'backend-tss-api_v2')))
sys.path.insert(0,str(HERE))
sys.path.insert(0,str(HERE/'benefit-profile'))
from native import HEADER,LINE
from source_runtime import PINS,checked_source
from benefit_source import PINS as BENEFIT_PINS,checked as checked_benefit_source


def once(value,old,new):
    if value.count(old)!=1:
        raise RuntimeError('Pinned composition boundary changed')
    return value.replace(old,new,1)


def api_guard_changes():
    public_main=checked_source(SOURCE,'main.py')
    guarded_main=once(public_main,'middleware = [DatabaseManager(',
        'from middleware.PosImportOrderGuard import ImportOrderGuard\n\nmiddleware = [DatabaseManager(')
    guarded_main=once(guarded_main,'MultipartMiddleware(), ActiveCartMiddleware()]',
        'MultipartMiddleware(), ActiveCartMiddleware(), ImportOrderGuard()]')
    return {'main.py':(public_main,guarded_main),
        'middleware/PosImportOrderGuard.py':('',(HERE/'order_guard.py').read_text())}


def outputs():
    for name in PINS:checked_source(SOURCE,name)
    for name in BENEFIT_PINS:checked_benefit_source(SOURCE,name)
    base=HERE.parent/'go/internal/poscheckout'
    changes={}
    before=(base/'confirmation.go').read_text()
    after=once(before,'\ttx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead})',
        '\ttx, importPrelude, err := beginImportConfirmation(ctx, db, orderID)')
    after=once(after,'\tdefer tx.Rollback()',
        '\tdefer closeScreeningCounterConnection(importPrelude)\n\tdefer tx.Rollback()\n\tdefer releaseScreeningCounter(context.Background(),tx,importPrelude)')
    after=once(after,'\titems, err := tx.QueryContext(ctx,',
        '\tif err = validateImportConfirmation(ctx, tx, importPrelude, orderID, userID, storeID, counterID); err != nil { return Confirmation{}, err }\n\tlegacyImport, err := lockLegacyImport(ctx, tx, orderID, userID, storeID, counterID)\n\tif err != nil { return Confirmation{}, err }\n\tif err = checkScreeningConfirmation(ctx, tx, importPrelude, legacyImport, orderID); err != nil { return Confirmation{}, err }\n\titems, err := tx.QueryContext(ctx,')
    after=once(after,'\tif err = applySafely(tx, apply); err != nil {',
        '\tif err = beforeImportMutation(ctx, tx, importPrelude, legacyImport); err != nil { return Confirmation{}, err }\n\tlegacyCoupon, err := lockLegacyImportCoupon(ctx, tx, legacyImport, orderID)\n\tif err != nil { return Confirmation{}, err }\n\tif err = applySafely(tx, apply); err != nil {')
    after=once(after,'membership, err := lockMembership(ctx, tx, orderID, userID, originalHeader, lines, false)',
        'membership, err := lockLegacyImportMembershipActivation(ctx, tx, legacyImport, orderID, userID, originalHeader, lines, false)')
    after=once(after,'finishMembership(ctx, tx, membership)',
        'finishLegacyImportMembershipActivation(ctx, tx, legacyImport, membership)')
    replay='\t\tif err = tx.Commit(); err != nil {\n\t\t\treturn Confirmation{}, err\n\t\t}\n\t\treturn confirmation(false,'
    after=once(after,replay,'\t\tif err = verifyLegacyImportCouponReplay(ctx,tx,legacyImport,orderID); err != nil { return Confirmation{}, err }\n\t\tif err = releaseScreeningCounter(ctx,tx,importPrelude); err != nil { return Confirmation{}, err }\n'+replay)
    # The sole new-proof COMMIT follows the source proof insertion. Existing
    # proof replay never creates a second import confirmation receipt.
    marker='\tif err = tx.Commit(); err != nil {\n\t\treturn Confirmation{}, err\n\t}\n\treturn confirmation(true,'
    replacement='\tif err = checkScreeningConfirmation(ctx, tx, importPrelude, legacyImport, orderID); err != nil { return Confirmation{}, err }\n\tif err = recordLegacyImportConfirmation(ctx, tx, legacyImport, orderID, legacyCoupon); err != nil { return Confirmation{}, err }\n\tif err = releaseScreeningCounter(ctx,tx,importPrelude); err != nil { return Confirmation{}, err }\n'+marker
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
    helper=(HERE/'legacy_import.go').read_text()+'\nconst LegacyImportHeaderSQL = '+json.dumps(HEADER)+'\nconst LegacyImportLineSQL = '+json.dumps(LINE)+'\n'
    changes['internal/poscheckout/legacy_import.go']=('',helper)
    changes['internal/poscheckout/screening.go']=('',(HERE/'screening.go').read_text())
    changes['internal/poscheckout/screening_counter.go']=('',(HERE/'screening_counter.go').read_text())
    changes['internal/poscheckout/screening_counter_definition.go']=('',(HERE/'screening_counter_definition.go').read_text())
    changes['internal/poscheckout/screening_head_metadata.go']=('',(HERE/'screening_head_metadata.go').read_text())
    changes['internal/poscheckout/screening_head_metadata_definition.go']=('',(HERE/'screening_head_metadata_definition.go').read_text())
    changes['internal/poscheckout/public_screening.go']=('',(HERE/'public_screening.go').read_text())
    changes['internal/poscheckout/public_screening_benefits.go']=('',(HERE/'public_screening_benefits.go').read_text())
    changes['internal/poscheckout/legacy_import_succession.go']=('',(HERE/'legacy_import_succession.go').read_text())
    changes['internal/poscheckout/legacy_import_membership_reference.go']=('',(HERE/'legacy_import_membership_reference.go').read_text())
    changes['internal/poscheckout/coupon_consumption.go']=('',(HERE/'coupon_consumption.go').read_text())
    patch=''.join(''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+path if old else '/dev/null',tofile='b/'+path)) for path,(old,new) in changes.items())
    public_changes=api_guard_changes()
    public_main=public_changes['main.py'][0]
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
        'authoritySuccession':{'contract':'pos-import-authority-succession-v1','activated':False,
            'purpose':'explicit manager approval for future stages; original scope and order preserved',
            'files':{name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in (
                'authority_succession.py','legacy_import_succession.go','native.py','protocol.py',
                'receiver.py','http_app.py','screening_transaction.py')}},
        'privateRuntime':{'contract':'pos-import-owned-celery-v1','activated':False,
            'files':{name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in (
                'private_celery.py','private_cache.py','cart_tracking.py','source_runtime.py',
                'runtime.py','screening_runtime.py','receiver.py','effects.py','transaction.py','model_compat.py')}},
        'benefits':{'automaticCoupon':'pos-csv-automatic-coupon-v1',
            'complementary':'pos-csv-pos-complementary-v1','activated':False,
            'history':'authenticated preload; no native historical fallback',
            'sourceFiles':BENEFIT_PINS,
            'files':{name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in (
                'benefit-profile/benefit_profile.py','benefit-profile/benefit_source.py',
                'benefit-profile/benefit_history.py','benefit-profile/benefit_claims.py',
                'benefit-profile/benefit_receipts.py','benefit-profile/benefit_codec.py',
                'benefit-profile/benefit_controls.py','benefit-profile/benefit_fence.py',
                'benefit-profile/benefit_native.py','benefit-profile/benefit_runtime.py',
                'benefit-profile/coupon_handoff.py','benefit-profile/benefit_history_heads.py',
                'benefit-profile/configuration_cache_snapshot.py',
                'benefit-profile/coupon_generation_controls.py',
                'benefit-profile/coupon_generation_resource.py',
                'benefit-profile/coupon-history-writers.review.json')}},
        'preparation':{'contract':'pos-import-order-preparation-v1','activated':False,
            'purpose':'source-cart-preview; no order/absence/payment receipt',
            'transaction':'fresh current authority; SELECT-only source execution; always rollback',
            'membershipBatch':'native preparationContract; defer automatic process only during catalog population',
            'files':{name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in (
                'order_preparation.py','cart_preparation.py','source_runtime.py','receiver.py','protocol.py','http_app.py')}},
        'sourceTransaction':{'contract':'pos-import-customer-first-snapshot-v1','activated':False,
            'files':{name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in ('screening_transaction.py','receiver.py')}},
        'correction':{'contract':'pos-import-manager-correction-v1','activated':False,
            'files':{name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in (
                'correction_profile.py','profiles.py','native.py','protocol.py','receiver.py','runtime.py')}},
        'screening':{'contract':'pos-csv-screening-2960-v1','schema':'pos-screening-schema-v1',
            'writers':'pos-screening-all-writers-v1','activated':False,
            'count':'qualified current operational projection; exact literal helper replay only',
            'physicalMetadataCommit':'34b2c65','goSha256':hashlib.sha256((HERE/'screening.go').read_bytes()).hexdigest()},
        'screeningCurrentCounter':{'contract':'pos-screening-current-counter-v1','activated':False,
            'historicalRouting':'independently qualified BQ baseline; current atomic contributions only',
            'files':{name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in (
                'screening_counter.py','screening_preparation.py','screening_profile.py','screening_counter.go',
                'screening_counter_definition.go','screening_head_metadata.go','screening_head_metadata_definition.go',
                'screening-counter-definition.json','screening-counter.review.sql',
                'screening-counter-writers.review.sql','screening-counter-bigquery.review.sql','screening-counter-grants.review.sql')}},
        'otherOriginCredits':{'contract':'pos-screening-origins-v1','activated':False,
            'files':{name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in (
                'screening_origin_pending.py','screening_profile.py')}},
        'publicBenefitBindingAbi':{'contract':'pos-node-screening-benefits-v1','activated':False,
            'scope':'optional immutable source descriptor/intent binding only; native asset/funding gates retained',
            'goSha256':hashlib.sha256((HERE/'public_screening_benefits.go').read_bytes()).hexdigest()},
        'couponConsumption':{'contract':'pos-csv-coupon-consumption-v1','activated':False,
            'goSha256':hashlib.sha256((HERE/'coupon_consumption.go').read_bytes()).hexdigest(),
            'deduction':'existing source Apply only; capture native before/after and log in same transaction'},
        'membership':{'contract':'pos-legacy-import-membership-v1','activated':False,
            'stagedContract':'pos-cancellation-membership-staged-v2',
            'activatedContract':'pos-cancellation-membership-provenance-v2',
            'historyContract':'pos-csv-membership-history-v1',
            'contactReferenceContract':'pos-csv-membership-contact-reference-v1',
            'stagedReferenceContract':'pos-csv-membership-staged-reference-v1',
            'referenceActivationContract':'pos-csv-membership-reference-activation-v1',
            'files':{name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in (
                'membership_profile.py','membership_history.py','membership_handoff.py','membership_cache.py','membership_consumer.py',
                'membership_reference.py',
                'membership_staged_reference.py',
                'legacy_import_membership_reference.go',
                'source_runtime.py','cart_preparation.py','order_preparation.py','profiles.py','native.py','receiver.py','effects.py','runtime.py','protocol.py','http_app.py')},
            'sourceFiles':__import__('membership_profile').PINS,
            'ordinaryProducerSha256':hashlib.sha256((HERE.parent/'pending-cancellation/membership_provenance.py').read_bytes()).hexdigest(),
            'ordinaryProducerFenceSha256':hashlib.sha256((HERE.parent/'pending-cancellation/membership_fence_contract.py').read_bytes()).hexdigest()}}
    return {HERE/'payments-import-overlay.patch':patch,HERE/'api-import-guard.patch':public_patch,HERE/'manifest.json':json.dumps(manifest,indent=2)+'\n'}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--write',action='store_true');args=parser.parse_args()
    for path,value in outputs().items():
        if args.write:path.write_text(value)
        elif not path.exists() or path.read_text()!=value:raise RuntimeError('Owned import overlay differs: '+path.name)
        print(path.name+' '+hashlib.sha256(value.encode()).hexdigest())
