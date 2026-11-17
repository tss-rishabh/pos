import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createOriginHistoryBridge,
  type OriginHistoryBridgeEvent,
} from '../../src/modules/screening-origins/bridge.js';
import {
  originCommandSchema,
  originDigest,
} from '../../src/modules/screening-origins/contracts.js';
import {
  originMembershipHistory,
  originMembershipHistoryContract,
  originMembershipPreviewContract,
  originMembershipScopeSchema,
  originMembershipPreviewScopeSchema,
} from '../../src/modules/screening-origins/membership-history.js';
import { originPreviewSchema } from '../../src/modules/screening-origins/preview-contracts.js';
import type { BoundedSelect } from '../../src/modules/warehouse/bounded-select.js';
import {
  cutoff,
  membershipGenerationContract,
  membershipGenerationPublicationContract,
  membershipGenerationSchema,
  membershipGenerationPublicationSchema,
  membershipHistoryDigest,
  membershipSelectionHash,
  publicMembershipHeadSchema,
  type MembershipExecution,
  type PublicMembershipHead,
} from '../../src/modules/checkout/screening-writer/membership-history.js';

const originKey = 'isolated-origin-membership-authority-'.repeat(2),
  captureKey = 'isolated-member-history-capture-'.repeat(2),
  publicationKey = 'isolated-member-history-publication-'.repeat(2),
  now = Date.parse('2026-06-15T06:30:00.500Z'),
  asOf = '2026-06-15 12:00:00',
  zone = 'Asia/Kolkata';

function fixture() {
  const head = publicMembershipHeadSchema.parse({
    contract: 'pos-membership-history-head-v1',
    origin: { schema: 'isolated_pos', serverUuid: randomUUID() },
    revision: '8',
    writersHash: 'f'.repeat(64),
  });
  const command = originCommandSchema.parse({
    contract: 'pos-screening-origin-command-v1',
    id: randomUUID(),
    origin: 'customer',
    customerId: '77',
    actorId: null,
    storeId: null,
    counterId: null,
    namespaceHash: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    cartHash: 'c'.repeat(64),
    referenceHash: 'd'.repeat(64),
    authorityHash: 'e'.repeat(64),
    quantity: 1,
    markerRows: 1,
    lineItemsEnabled: true,
    phase: 'PREPARED',
    orderId: null,
    lines: [],
    markers: [],
    creationHash: null,
    closureHash: null,
    version: 1,
    createdAt: now - 500,
    updatedAt: now - 500,
    expiresAt: now + 59000,
  });
  const scope = originMembershipScopeSchema.parse({
    contract: originMembershipHistoryContract,
    commandId: command.id,
    origin: command.origin,
    customerId: command.customerId,
    requestHash: command.requestHash,
    cartHash: command.cartHash,
    authorityHash: command.authorityHash,
    configurationHash: '9'.repeat(64),
    sourceTimeZone: zone,
    asOf,
    cutoff: cutoff(asOf),
  });
  const preview = originPreviewSchema.parse({
    contract: 'pos-screening-origin-preview-v1',
    previewId: randomUUID(),
    purpose: 'cart-mutation',
    origin: command.origin,
    customerId: command.customerId,
    actorId: null,
    storeId: null,
    counterId: null,
    authorityHash: command.authorityHash,
    namespaceHash: command.namespaceHash,
    requestHash: command.requestHash,
    cartHash: command.cartHash,
    issuedAt: command.createdAt,
    expiresAt: command.expiresAt,
  });
  const previewScope = originMembershipPreviewScopeSchema.parse({
    contract: originMembershipPreviewContract,
    preview,
    configurationHash: scope.configurationHash,
    sourceTimeZone: zone,
    asOf,
    cutoff: cutoff(asOf),
  });
  const last = {
    id: '100',
    paymentMethod: 3,
    createdAt: '2026-06-13 12:00:00',
    lines: [{ lineId: '1000', productId: '9', isExclusiveOrder: 1 }],
  };
  // One authentic old generation spans the lower boundary that the new
  // execution must re-evaluate; it is not an operation-scoped empty history.
  const selection = {
    lastDeliveredOrder: last,
    recentDeliveredOrders: [
      last,
      {
        id: '99',
        paymentMethod: 1,
        createdAt: '2026-04-30 13:00:00',
        lines: [{ lineId: '990', productId: '9', isExclusiveOrder: 0 }],
      },
    ],
  };
  const sourceAsOf = '2026-06-14 12:00:00',
    capturedAt = now - 86400000 - 400;
  const body = {
    contract: membershipGenerationContract,
    generationId: '8'.repeat(64),
    customerId: '77',
    sourceTimeZone: zone,
    asOf: sourceAsOf,
    cutoff: cutoff(sourceAsOf),
    configurationHash: scope.configurationHash,
    head,
    sourceOrderCount: '2',
    sourceSelectedOrderCount: '2',
    sourceLineCount: '2',
    selection,
    selectionHash: membershipSelectionHash(selection),
    capturedAt,
  };
  const capture = membershipGenerationSchema.parse({
    ...body,
    signature: membershipHistoryDigest('generation', body, captureKey),
  });
  const publicationBody = {
    contract: membershipGenerationPublicationContract,
    generationId: capture.generationId,
    sourceCaptureHash: capture.signature,
    warehouseOrderCount: '2',
    warehouseSelectedOrderCount: '2',
    warehouseLineCount: '2',
    warehouseSelectionHash: capture.selectionHash,
    publishedAt: capturedAt + 10,
  };
  const publication = membershipGenerationPublicationSchema.parse({
    ...publicationBody,
    signature: membershipHistoryDigest('publication', publicationBody, publicationKey),
  });
  const record = {
    generationId: capture.generationId,
    sourceCapture: capture,
    publication,
    warehouseSelection: structuredClone(selection),
  };
  const read = vi.fn(async (_input: BoundedSelect, _signal: AbortSignal) =>
      JSON.stringify({ generations: [record] }),
    ),
    requestGeneration = vi.fn(
      async (
        _execution: MembershipExecution,
        _head: PublicMembershipHead,
        _call: { signal?: AbortSignal },
      ) => {},
    ),
    service = originMembershipHistory(
      {
        view: 'tssgcp2025.tss_mysql_raw_layer.isolated_membership',
        maxBytes: 50000000,
        timeoutMs: 8000,
        sourceTimeZone: zone,
      },
      { originKey, captureKey, publicationKey, memberIds: ['10'] },
      {
        select: { read },
        demands: { requestGeneration },
        clock: () => now,
      },
    );
  return {
    head,
    command,
    scope,
    preview,
    previewScope,
    record,
    read,
    requestGeneration,
    service,
    commandInput: {
      command,
      commandProof: originDigest(originKey, 'command', command),
      scope,
      head,
    },
    previewInput: {
      preview,
      previewProof: originDigest(originKey, 'preview-context', preview),
      scope: previewScope,
      head,
    },
  };
}

describe('genuine source membership history', () => {
  it('rebinds unchanged-head history to a real command and re-evaluates the rolling cutoff', async () => {
    const f = fixture(),
      value = await f.service.read(f.commandInput, AbortSignal.timeout(1000));
    expect(value.scope.commandId).toBe(f.command.id);
    expect(value.selection.recentDeliveredOrders.map((order) => order.id)).toEqual(['100']);
    expect(value.selection.lastDeliveredOrder?.id).toBe('100');
    expect(value.fetchedAt).toBe(now);
    expect(value.expiresAt).toBe(f.command.expiresAt);
    expect(f.requestGeneration).not.toHaveBeenCalled();
    expect(f.read).toHaveBeenCalledOnce();
    const query = f.read.mock.calls[0];
    expect(query?.[0].params).toMatchObject({
      customer: '77',
      revision: '8',
      schema: 'isolated_pos',
      writers: f.head.writersHash,
      asOf,
      cutoff: cutoff(asOf),
    });
    const { signature, ...body } = value;
    expect(signature).toBe(originDigest(originKey, 'membership-history', body));
    expect('checkoutId' in value.scope).toBe(false);
  });

  it('binds preview facts to a separate server preview, never an order or checkout capability', async () => {
    const f = fixture(),
      value = await f.service.readPreview(f.previewInput, AbortSignal.timeout(1000));
    expect(value.contract).toBe(originMembershipPreviewContract);
    expect(value.scope.preview).toEqual(f.preview);
    expect(originCommandSchema.safeParse(f.preview).success).toBe(false);
    const { signature, ...body } = value;
    expect(signature).toBe(originDigest(originKey, 'membership-preview', body));
    expect(signature).not.toBe(originDigest(originKey, 'membership-history', body));
    expect('commandId' in value.scope).toBe(false);
  });

  it.each(['customer', 'authority', 'command-proof', 'head', 'warehouse', 'source-signature'])(
    'refuses changed %s without manufacturing replacement facts',
    async (changed) => {
      const f = fixture();
      if (changed === 'customer') f.commandInput.scope.customerId = '78';
      if (changed === 'authority') f.commandInput.scope.authorityHash = '0'.repeat(64);
      if (changed === 'command-proof') f.commandInput.commandProof = '0'.repeat(64);
      if (changed === 'head') f.commandInput.head.revision = '9';
      if (changed === 'warehouse')
        f.record.warehouseSelection.recentDeliveredOrders[0]!.lines[0]!.isExclusiveOrder = 0;
      if (changed === 'source-signature') f.record.sourceCapture.signature = '0'.repeat(64);
      await expect(f.service.read(f.commandInput, AbortSignal.timeout(1000))).rejects.toThrow();
      expect(f.requestGeneration).not.toHaveBeenCalled();
    },
  );

  it('queues only a generic generation demand on absence, with no made-up Node operation', async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce(JSON.stringify({ generations: [] }));
    await expect(
      f.service.readPreview(f.previewInput, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: 'SCREENING_ORIGIN_MEMBERSHIP_GENERATION_REQUIRED' });
    expect(f.requestGeneration).toHaveBeenCalledOnce();
    expect(f.requestGeneration.mock.calls[0]).toHaveLength(3);
    const request = f.requestGeneration.mock.calls[0]?.[0];
    expect(request).toEqual({
      customerId: '77',
      configurationHash: f.scope.configurationHash,
      sourceTimeZone: zone,
      asOf,
      cutoff: cutoff(asOf),
    });
  });

  it('rejects expired or forged preview authority before warehouse I/O', async () => {
    const f = fixture();
    f.previewInput.previewProof = '0'.repeat(64);
    await expect(
      f.service.readPreview(f.previewInput, AbortSignal.timeout(1000)),
    ).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
  });

  it('serves the real private preview route and traces only its authenticated pseudonymous actor', async () => {
    const f = fixture(),
      events: OriginHistoryBridgeEvent[] = [];
    const app = await createOriginHistoryBridge({
      sourceKey: originKey,
      membershipHistory: f.service,
      history: {
        async read() {
          throw new Error('Unexpected customer-history call');
        },
      },
      clock: () => now,
      observe: (event) => events.push(event),
    });
    try {
      const data = { ...f.previewInput, issuedAt: now, expiresAt: now + 29000 };
      const response = await app.inject({
        method: 'POST',
        url: '/internal/screening-origins/membership-preview',
        payload: { data, proofHash: originDigest(originKey, 'membership-preview-request', data) },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        module: 'screening-origins',
        resource: 'membership-history',
        eventId: 'screening-origins.membership-history.preview.completed',
        userId: '77',
      });
      const encoded = JSON.stringify(events);
      for (const secret of [
        originKey,
        captureKey,
        publicationKey,
        f.previewInput.previewProof,
        f.command.id,
      ])
        if (secret) expect(encoded).not.toContain(secret);
      expect(encoded).not.toContain('requestHash');
    } finally {
      await app.close();
    }
  });
});
