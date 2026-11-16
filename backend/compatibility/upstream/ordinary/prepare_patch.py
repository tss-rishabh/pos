"""Prepare the POS ordinary-checkout patch against exact committed payments.

Default verification is read-only. Use --write explicitly to regenerate artifacts.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from prepare_patches import TARGETS,diff,original,replace_once


def private_auth_source():
    source=original('payments','auth/Auth.go')
    source=replace_once(source,'"backend-tss-domestic_payments_api/utils"','"backend-tss-domestic_payments_api/internal/poscheckout"')
    for old in ['utils.Warnf("Malformed token: %v", err)', 'utils.Error(err, "JWT 512 Key Verification error")', 'utils.Error(err, "JWT 256 Key Verification error")']:
        source=replace_once(source,old,'poscheckout.RecordHTTPEvent(c.Request.Context(), poscheckout.AuthenticationRejected)')
    source=replace_once(source,'\t\tutils.Debugf("jwt.subject=%s", jot.Subject())\n\t\tutils.Debugf("jwt.expiration=%v", jot.ExpirationTime())\n\t\tutils.Debugf("jwt.issuedAt=%v", jot.IssuedAt())', '\t\tposcheckout.RecordHTTPEvent(c.Request.Context(), poscheckout.AuthenticationAccepted)')
    return source


def patch():
    before=original('payments','juspay/Order.go')
    after=replace_once(before,'"backend-tss-domestic_payments_api/utils"','"backend-tss-domestic_payments_api/utils"\n\t"backend-tss-domestic_payments_api/internal/poscheckout"')
    after=replace_once(after,'\tCreateCustomer(c)\n\n\t// Getting IP', '\t// Ordinary POS confirmation commits its complete projection before success.\n\tif tryConfirmPOSCheckout(c, &o) {\n\t\treturn\n\t}\n\n\tCreateCustomer(c)\n\n\t// Getting IP')
    changes={
        '\tutils.Debugf("ProcessOrder: start")\n':'',
        'utils.Warnf("Invalid order request,Got error parsing PO json: ip=%s origin=%s userAgent=%s error=%v", c.ClientIP(), c.GetHeader("Origin"), c.GetHeader("User-Agent"), err)':'poscheckout.RecordHTTPEvent(c.Request.Context(), poscheckout.OrderValidationRejected)',
        '\t\tutils.Debugf("[Retry %d] OrderID=%d rows=%d fetchedID=%d orderUser=%d contextUser=%s", i, po.Order, res.RowsAffected, o.ID, o.User, user_id)\n':'',
        '\t\t\tutils.Debugf("Order found at iteration %d: orderID=%d orderUser=%d contextUser=%s", i, o.ID, o.User, user_id)\n':'',
        'utils.Warnf("Order not found after retries: orderID=%d contextUser=%s", po.Order, user_id)':'poscheckout.RecordHTTPEvent(c.Request.Context(), poscheckout.OrderNotFound)',
        'utils.Errorf(nil, "Invalid user_id in context: %s (error: %v)\\n", user_id, err)':'poscheckout.RecordHTTPEvent(c.Request.Context(), poscheckout.OrderAuthorizationRejected)',
        'utils.Infof("Unauthorized access attempt: order_id=%d, order_user=%d, context_user=%s\\n",\n\t\t\to.ID, o.User, user_id)':'poscheckout.RecordHTTPEvent(c.Request.Context(), poscheckout.OrderAuthorizationRejected)',
        'utils.Debugf("User %d authorized for order %d. Proceeding to create Juspay customer\\n", userIDInt, o.ID)':'poscheckout.RecordHTTPEvent(c.Request.Context(), poscheckout.OrderAuthorizationAccepted)',
    }
    for old,new in changes.items():after=replace_once(after,old,new)
    start=after.index('func ProcessOrder(c *gin.Context)')
    boundary=after.index('\tCreateCustomer(c)',start)
    prefix=after[start:boundary].replace('utils.Db.','utils.Db.New().LogMode(false).')
    after=after[:start]+prefix+after[boundary:]
    result=diff('juspay/Order.go',before,after)
    before=original('payments','auth/Auth.go')
    result+=diff('auth/Auth.go',before,private_auth_source())
    before=original('payments','main.go')
    after=replace_once(before,'\trouter := gin.Default()', '\trouter := gin.New()\n\t// No request/header/body dumps, including panic and broken-connection paths.\n\trouter.Use(poscheckout.PrivateHTTP(os.Getenv, os.Stdout))')
    after=replace_once(after,'\trouter.Use(gin.Recovery())\n','')
    after=replace_once(after,'"github.com/gin-gonic/gin"','"github.com/gin-gonic/gin"\n\t"backend-tss-domestic_payments_api/internal/poscheckout"')
    result+=diff('main.go',before,after)
    # This patch is composed after the pinned exchange patch. Its delivery logs
    # must use the same verified operator correlation, never order.User.
    before=(ROOT/'payload/juspay/pos_exchange_http.go').read_text()
    after=replace_once(before,'"backend-tss-domestic_payments_api/internal/posstock"','"backend-tss-domestic_payments_api/internal/posstock"\n\t"backend-tss-domestic_payments_api/internal/poscheckout"')
    after=replace_once(after,'\tif confirmation.Created {','\tif confirmation.Created {\n\t\toperatorID := poscheckout.OperatorID(c.Request.Context())')
    for name in ['pos-exchange-inventory-sync','pos-exchange-order-producer','pos-exchange-order-email']:
        after=replace_once(after,'posCompatibilityOutcome("'+name+'", requestID, order, resp, errs)','posCompatibilityOutcome("'+name+'", requestID, operatorID, resp, errs)')
    after=replace_once(after,'func posCompatibilityOutcome(resource, requestID string, order *Order,','func posCompatibilityOutcome(resource, requestID string, operatorID *string,')
    after=replace_once(after,'\t\tUserID          int    `json:"userId"`\n\t\tOrderID         int    `json:"orderId"`','\t\tUserID          *string `json:"userId"`')
    after=replace_once(after,'requestID, order.User, order.ID}', 'requestID, operatorID}')
    result+=diff('juspay/pos_exchange_http.go',before,after)
    before=original('payments','juspay/model.go')
    after=replace_once(before,'func (o *Order) OrderAndStockConfirmed(Db *gorm.DB, reduceStock ...bool) bool {\n', 'func (o *Order) OrderAndStockConfirmed(Db *gorm.DB, reduceStock ...bool) bool {\n\t// Callbacks and cron retries share the same POS projection proof.\n\tif handled, confirmed := tryConfirmPOSCheckoutInternal(o, Db); handled {\n\t\treturn confirmed\n\t}\n')
    result+=diff('juspay/model.go',before,after)
    paths=[('juspay/'+name,ROOT/'payload/juspay'/name)for name in ['pos_checkout_http.go','pos_checkout_records.go','pos_checkout_source.go']]
    paths += [('internal/poscheckout/'+file.name,file) for file in sorted((ROOT/'go/internal/poscheckout').glob('*.go')) if not file.name.endswith('_test.go')]
    paths.append(('cmd/pos-checkout-effects/main.go',ROOT/'payload/cmd/pos-checkout-effects/main.go'))
    for filename,file in paths:result+=diff(filename,None,file.read_text())
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--write',action='store_true');arguments=parser.parse_args()
    content=patch();target=ROOT/'patches/payments-pos-checkout.patch'
    manifest={'contract':'pos-checkout-projection-v1','sourceCommit':TARGETS['payments'][1],'sha256':hashlib.sha256(content.encode()).hexdigest(),'patch':'patches/payments-pos-checkout.patch','postcommitMigration':'ordinary/migration.sql','customerConsentContract':'pos-customer-contact-consent-v1','customerConsentMigration':'ordinary/customer-consent-migration.sql'}
    if arguments.write:
        target.write_text(content);(ROOT/'ordinary-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    elif not target.exists()or target.read_text()!=content or json.loads((ROOT/'ordinary-manifest.json').read_text())!=manifest:
        raise RuntimeError('The saved ordinary-checkout patch differs from its reviewed inputs')
    print(manifest['sha256'])
