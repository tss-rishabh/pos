import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const source = process.env.SOURCE_API_ROOT || '/Users/rishabhbhatia/code/backend-tss-api_v2';
describe.skipIf(!existsSync(source))('actual pinned omnichannel source behavior', () => {
  it('records the unsafe source contract explicitly instead of claiming response-identical OTP parity', () => {
    const result = spawnSync('python3', ['tools/customer-otp/source-otp-oracle.py', source], {
      encoding: 'utf8',
      timeout: 10000,
    });
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
