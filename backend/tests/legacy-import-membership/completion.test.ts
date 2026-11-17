import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { csvMembershipImportProfile } from '../../src/modules/legacy-order-imports/membership-profile/adapter.js';
import { validateCsvMembershipCompletionSnapshot } from '../../src/modules/legacy-order-imports/membership-profile/completion.js';
import { adapterOptions, memberEvidence } from './adapter-fixtures.js';

describe('immutable CSV membership completion binding', () => {
  it('requires explicit selected flags for each trusted planned member SKU', () => {
    const disabled = csvMembershipImportProfile({ ...adapterOptions, contract: '' });
    expect(disabled.requiresCurrentReads).toBe(true);
    for (const productId of adapterOptions.productIds) {
      const f = memberEvidence();
      f.plan.lines[0]!.productId = productId;
      expect(() => disabled.assertReady!(f.plan)).toThrow();
    }
  });
  it('copies the trusted registry and refuses malformed or incomplete selected registries', () => {
    const ids = ['10', '12'],
      disabled = csvMembershipImportProfile({ ...adapterOptions, contract: '', productIds: ids });
    ids.push('11');
    const f = memberEvidence();
    f.plan.lines[0]!.productId = '11';
    expect(() => disabled.assertReady!(f.plan)).not.toThrow();
    expect(() =>
      csvMembershipImportProfile({ ...adapterOptions, productIds: ['10', '10'] }),
    ).toThrow();
    const incomplete = csvMembershipImportProfile({ ...adapterOptions, freeProductId: '13' });
    expect(() => incomplete.assertReady!(memberEvidence().plan)).toThrow();
  });
  it.each(['offline', 'shopify'] as const)(
    'validates %s evidence without a plan, current keys or entitlement',
    (kind) => {
      const f = memberEvidence(kind, true),
        completed = { ...f.state, kind, order: f.order };
      expect(validateCsvMembershipCompletionSnapshot(f.snapshot, completed)).toEqual(f.snapshot);
      // The pure read has no configuration/database dependency. New work using
      // unselected or rotated settings is independently refused at its gate.
      const disabled = csvMembershipImportProfile({
        ...adapterOptions,
        contract: '',
        sourceProofKey: 'rotated',
        membershipProofKey: 'rotated',
      });
      expect(() => disabled.assertReady!(memberEvidence().plan)).toThrow();
      expect(validateCsvMembershipCompletionSnapshot(f.snapshot, completed)).toEqual(f.snapshot);
    },
  );
  it.each([
    'scope',
    'plan',
    'request',
    'customer',
    'method',
    'header',
    'line',
    'duplicate',
    'manifest',
    'provenance',
  ] as const)('refuses changed %s immutable bindings', (changed) => {
    const f = memberEvidence('offline', true),
      completed = { ...f.state, kind: f.plan.kind, order: f.order };
    if (changed === 'scope') completed.scope = { ...completed.scope, operationId: randomUUID() };
    if (changed === 'plan') completed.planHash = 'f'.repeat(64);
    if (changed === 'request') completed.requestHash = 'f'.repeat(64);
    if (changed === 'customer') completed.authority = { ...completed.authority, customerId: '88' };
    if (changed === 'method') completed.order = { ...completed.order, method: 15 };
    if (changed === 'header') completed.order = { ...completed.order, headerHash: 'f'.repeat(64) };
    if (changed === 'line') completed.order.lines[0]!.inputHash = 'f'.repeat(64);
    if (changed === 'duplicate') completed.order.lines.push({ ...completed.order.lines[0]! });
    if (changed === 'manifest') f.snapshot.receipt.additionalLines = [];
    if (changed === 'provenance') f.snapshot.receipt.provenance.customerId = '88';
    expect(() => validateCsvMembershipCompletionSnapshot(f.snapshot, completed)).toThrow();
  });
  it('bounds the frozen receipt and rejects unknown fields', () => {
    const f = memberEvidence(),
      completed = { ...f.state, kind: f.plan.kind, order: f.order };
    expect(() =>
      validateCsvMembershipCompletionSnapshot(
        { ...f.snapshot, privateContact: 'fixture-canary' },
        completed,
      ),
    ).toThrow();
    for (const field of ['before', 'confirmed'] as const)
      f.snapshot.receipt.provenance[field] = f.snapshot.receipt.provenance.confirmed.map((row) => ({
        ...row,
        value: 'x'.repeat(65535),
      }));
    expect(() => validateCsvMembershipCompletionSnapshot(f.snapshot, completed)).toThrow();
  });
});
