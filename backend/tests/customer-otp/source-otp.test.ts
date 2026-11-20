import { describe, expect, it } from 'vitest';
import { goldenSpawnResult } from '../golden/load.js';
/**
 * Source evidence only (V2, 20 Nov 2026; see tests/golden/INVENTORY.md): this file asserts
 * facts of the pinned legacy capture and runs no rewrite code.
 * Reason: this records API-v2's own OTP internals; the rewrite calls omnichannel-sendotp/verifyotp
 * unchanged (request shape: tests/customer-otp/api-v2.test.ts).
 */

// Captured from tools/customer-otp/source-otp-oracle.py against backend-tss-api_v2@2960acb.
describe('actual pinned omnichannel source behavior', () => {
  it('records the unsafe source contract explicitly instead of claiming response-identical OTP parity', () => {
    const result = goldenSpawnResult('customer-otp', 'source-otp');
    expect(result.status, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout) as unknown).toEqual({
      sourceCommit: '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
      digits: 4,
      mobile: true,
      email: true,
      smsMethod: 'GET',
      smsQueryKeys: ['mask', 'method', 'msg', 'msg_type', 'password', 'send_to', 'userid', 'v'],
      redisExpirySupplied: false,
      wrongAttemptsBeforeCorrect: 20,
      correctAfterTwentyWrong: true,
      foreignStoreAccepted: true,
      proofReplayAccepted: true,
      globalCodeRetainedAfterVerify: true,
      fallbackDelay: [20],
      fallbackStillSendsAfterVerify: true,
      emailTemplate: 'use-tss-points-and-money',
    });
  });
});
