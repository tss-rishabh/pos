// GENERATED from 70b80159016db39a73572f80bfa87c47201c0a9f:new-src/api/services/vinculum/storeOrderVinc.ts
// Original SHA256 9d3c9c6bd3faa51de5b6e166f8a503088a4819ab521d4a1ecc424d32f9022900
// No bootstrap, credentials, global logger or source database import is executed.
export function createSourceStoreRuntime(ports) {
const {config,getStoreOrderLocationAndRef,getProductsForPackShip,getOrderProductsForNetcore,hasAutoDeliverSuccess,clearAutoDeliverSuccess,executeVinculumJsonRequest,upsertAutoDeliverLog,enqueue,sendSlackAlert,axios} = ports;
const STORE_ORDER_QUEUE='store-order-vinc-pack-ship-deliver';
const LOG_PREFIX='Store Order :';
const lastVinculumCallAtByPlatform=new Map();
const getErrorMessage=(_error)=>'UPSTREAM_ERROR';
const getErrorStack=(_error)=>'';
const isSingleLineMembershipOrder=()=>{throw new Error('MEMBERSHIP_PROFILE_NOT_ALLOWED');};
const markMembershipOrderDelivered=isSingleLineMembershipOrder;
const prepareMembershipPackShipPayload=isSingleLineMembershipOrder;
"use strict";
function getInitialDelaySeconds(source, platform) {
    return source === 'MEMBERSHIP'
        ? config.sqs.membershipOrderInitialDelaySeconds[platform]
        : config.sqs.storeOrderInitialDelaySeconds[platform];
}
function getRetryDelaySeconds(source, platform) {
    return source === 'MEMBERSHIP'
        ? config.sqs.membershipOrderRetryDelaySeconds[platform]
        : config.sqs.storeOrderRetryDelaySeconds[platform];
}
async function paceVinculumCall(platform) {
    const { maxRequests, windowMs } = config.vinculum.rateLimits[platform];
    if (maxRequests <= 0)
        return;
    const minIntervalMs = windowMs / maxRequests;
    const lastCallAt = lastVinculumCallAtByPlatform.get(platform) ?? 0;
    const wait = lastCallAt + minIntervalMs - Date.now();
    if (wait > 0)
        await new Promise(resolve => setTimeout(resolve, wait));
    lastVinculumCallAtByPlatform.set(platform, Date.now());
}
async function prepareStorePackShipPayload(orderId, hasProductIds, platform) {
    const [{ orderRefNo, locationCode }, products] = await Promise.all([
        getStoreOrderLocationAndRef(orderId),
        getProductsForPackShip(orderId, hasProductIds),
    ]);
    return {
        externalOrderno: orderId,
        channelCode: locationCode,
        whCode: locationCode,
        status: platform,
        weight: '0.5',
        length: '10',
        breadth: '10',
        height: '10',
        noofbox: '1',
        transporterName: '',
        trackingno: orderRefNo,
        // deliveryNo:      '',
        items: products.map((p, index) => ({
            lineno: String(index + 1), extLineno: String(p.id), sku: String(p.productId),
            tagLoopCode: '', qty: String(p.qty ?? 0), serialNos: [],
        })),
    };
}
function prepareDeliverPayload(orderId) {
    return {
        orders: [{
                orderNo: orderId, siteCode: '', status: 'DELIVERED',
                deliveryNo: '', pod: '', deliveryDate: '', awbNo: '',
            }],
    };
}
async function fireNetcoreEvents(orderId, log) {
    try {
        const { baseUrl, appId, appKey } = config.events;
        if (!baseUrl) {
            log.warn({ orderId }, 'TSS_EVENTS_URL not set — skipping Netcore events');
            return;
        }
        const products = await getOrderProductsForNetcore(orderId);
        if (!products?.length) {
            log.warn({ orderId }, 'no products found for Netcore event');
            return;
        }
        const userId = products[0].userId;
        const headers = { 'Content-Type': 'application/json', app_id: appId, app_key: appKey };
        const total = products.reduce((s, p) => s + (p.qty ?? 0), 0);
        await axios.post(`${baseUrl}/send-netcore-activity-event`, {
            order_id: orderId,
            user_id: userId,
            product_data: products.map(p => ({
                parent_prod_id: p.parentProdId,
                prod_id: p.prodId,
                quantity: p.qty,
                url_key: p.urlKey,
                amount: p.price,
                gender_type: p.genderType,
            })),
            order_line_item_status: 'DELIVERED',
            total_products_quantity: total,
        }, { headers, timeout: 10000 });
        await axios.post(`${baseUrl}/update-netcore-user-contact`, {
            user_id: userId,
            fields_to_syn: ['include_all'], // note: intentional typo — events service expects "fields_to_syn"
        }, { headers, timeout: 10000 });
        log.info({ orderId, userId }, 'Netcore events fired for DELIVER success');
    }
    catch (err) {
        log.error({ orderId, error: getErrorMessage(err), stack: getErrorStack(err) }, 'Netcore events failed — ignored (fire-and-forget)');
    }
}
async function processStoreOrderVincStatus(orderId, hasProductIds, platform, log, receiveCount = 1, source = 'STORE', force = false) {
    const queueUrl = config.sqs.storeOrderQueueUrl;
    const logCtx = { orderId, platform, source };
    const label = source === 'MEMBERSHIP' ? 'Membership Order' : 'Store Order';
    let result;
    // Idempotency guard: SQS is at-least-once, and a failed next-stage enqueue below
    // redelivers this message after the Vinculum send already succeeded. In both cases
    // skip the duplicate send and go straight to continuing the chain.
    //
    // Unconditional, force included. A forced resend works by clearing the stale SUCCESS
    // record before the message is enqueued (clearAutoDeliverSuccess, called by whoever
    // enqueues — the controller for the requested stage, the chaining block below for the
    // stages after it), so by the time we get here there is simply no SUCCESS row to skip.
    // Retries then re-send on their own, and once the real send lands its fresh SUCCESS row
    // guards redeliveries exactly as it would for any other message. Letting force bypass
    // this check instead would re-send to Vinculum on every redelivery of the same message.
    const alreadySucceeded = await hasAutoDeliverSuccess(orderId, platform);
    if (alreadySucceeded) {
        log.warn({ orderId, platform }, `${LOG_PREFIX} ${platform} already succeeded in Vinculum — skipping duplicate send, continuing chain`);
        result = { status: 'ALREADY_SUCCEEDED', response: null };
    }
    else {
        const url = platform === 'DELIVER' ? config.vinculum.orderDeliveredUrl : config.vinculum.orderShippedUrl;
        const payload = platform === 'DELIVER'
            ? prepareDeliverPayload(orderId)
            : source === 'MEMBERSHIP'
                ? await prepareMembershipPackShipPayload(orderId, hasProductIds, platform)
                : await prepareStorePackShipPayload(orderId, hasProductIds, platform);
        if (!url)
            throw new Error(`VINC URL not configured for platform ${platform}`);
        log.debug({ orderId, platform, payload }, `${LOG_PREFIX} ${platform} payload prepared`);
        await paceVinculumCall(platform);
        const response = await executeVinculumJsonRequest(payload, url);
        log.info({ orderId, platform, response, receiveCount }, `${LOG_PREFIX} ${platform} Vinculum response received (attempt ${receiveCount})`);
        const isSuccess = response.responseCode === 0 && response.responseMessage === 'Success';
        // Quota exceeded is logged distinctly for visibility, but retried exactly like any
        // other retryable failure below — the pacing gate above is what's meant to prevent
        // it from happening in the first place, so it doesn't need its own retry budget.
        const isQuotaExceeded = response.responseCode === 13 && response.responseMessage === 'API Hit Quota Exceeded';
        // Only "order not created in Vinculum yet" codes are retryable; responseCode 1
        // (duplicate/already processed) is permanent — log UNEXPECTED, don't retry.
        const isRetryable = !isSuccess && ![0, 1].includes(response.responseCode) && response.responseMessage !== 'Success';
        await upsertAutoDeliverLog({
            orderId: orderId,
            productId: 0,
            // Smallest item id stands in for "which subset of the order this push covers" —
            // stable regardless of what order hasProductIds arrives in, and (since an item
            // can only belong to one shipment/store on a given order) collision-safe.
            hasProductId: hasProductIds.length > 0 ? hasProductIds.reduce((left, right) => BigInt(left) < BigInt(right) ? left : right) : null,
            platform,
            retries: receiveCount,
            request: JSON.stringify(payload),
            response: JSON.stringify(response),
            status: isSuccess ? 'SUCCESS' : isQuotaExceeded ? 'QUOTA_EXCEEDED' : isRetryable ? 'FAILED' : 'UNEXPECTED',
            message: isSuccess
                ? `${label} ${platform} successfully`
                : isQuotaExceeded
                    ? `Vinculum API quota exceeded while ${platform} ${label}`
                    : isRetryable
                        ? `Error while ${platform} ${label}`
                        : `Unexpected response while ${platform} ${label}`,
        });
        if (isRetryable) {
            log.warn({ orderId, platform, response }, `${LOG_PREFIX} Vinculum ${platform} failed — SQS will retry`);
            throw new Error(`Vinculum ${platform} non-success: ${JSON.stringify(response)}`);
        }
        if (!isSuccess) {
            log.error({ orderId, platform, response }, `${LOG_PREFIX} Vinculum ${platform} unexpected response — not retrying`);
            await sendSlackAlert(config.sqs.slackWebhookUrl, [
                `[backend-sync-api] ${source.toLowerCase()}-order UNEXPECTED: order ${orderId} got a non-retryable Vinculum response on ${platform} — chain stopped, manual check needed.`,
                ``,
                `*Response*`,
                `> ${JSON.stringify(response)}`,
            ].join('\n'));
            return { status: 'UNEXPECTED', response };
        }
        log.info({ ...logCtx }, `${label} ${platform} success`);
        result = { status: 'SUCCESS', response };
    }
    // force cascades forward: if this stage needed forcing, Vinculum's report of success on it
    // was wrong, so whatever the next stage has on record can't be trusted either. Clearing
    // that record here — before its message exists — is what makes the resend happen, since
    // the guard above is unconditional. Gated on a real send: on a redelivery this stage reads
    // ALREADY_SUCCEEDED, meaning the attempt that actually sent already did the clearing, and
    // repeating it could wipe a legitimate SUCCESS the next stage has since written.
    const cascadeForce = force && result.status === 'SUCCESS';
    if (platform === 'PACK') {
        const delay = getInitialDelaySeconds(source, 'SHIP');
        if (cascadeForce) {
            const cleared = await clearAutoDeliverSuccess(orderId, 'SHIP');
            log.warn({ ...logCtx, cleared }, `${LOG_PREFIX} force cascading — cleared SHIP SUCCESS record(s)`);
        }
        const taskId = await enqueue(STORE_ORDER_QUEUE, queueUrl, { orderId, hasProductIds, platform: 'SHIP', source, force }, delay);
        log.info({ ...logCtx, nextTaskId: taskId, delay, force }, 'SHIP enqueued');
    }
    else if (platform === 'SHIP') {
        const delay = getInitialDelaySeconds(source, 'DELIVER');
        if (cascadeForce) {
            const cleared = await clearAutoDeliverSuccess(orderId, 'DELIVER');
            log.warn({ ...logCtx, cleared }, `${LOG_PREFIX} force cascading — cleared DELIVER SUCCESS record(s)`);
        }
        const taskId = await enqueue(STORE_ORDER_QUEUE, queueUrl, { orderId, hasProductIds, platform: 'DELIVER', source, force }, delay);
        log.info({ ...logCtx, nextTaskId: taskId, delay, force }, 'DELIVER enqueued');
    }
    else {
        // Membership orders are digital: mirror the DELIVER into our own DB. Gate on the
        // single-line-membership check first so we don't open a write transaction otherwise.
        if (source === 'MEMBERSHIP' && await isSingleLineMembershipOrder(orderId)) {
            await markMembershipOrderDelivered(orderId, log);
        }
        await fireNetcoreEvents(orderId, log); // bounded durable effect receipts, same payload/order
    }
    return result;
}

return {process:processStoreOrderVincStatus,packShip:prepareStorePackShipPayload,deliver:prepareDeliverPayload,initialDelay:getInitialDelaySeconds,retryDelay:getRetryDelaySeconds};
}
