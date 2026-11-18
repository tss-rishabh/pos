import { describe, expect, it } from 'vitest';
import { goldenSourceStatusOracle } from './source-helper.js';
import { sourceStatusBody } from '../../src/modules/legacy-order-status/domain.js';
import { command, snapshot } from './fixtures.js';
describe('original whole-order callback/task contract', () => {
  it('sends every physical HP once for each supported platform and task always uses PACK', () => {
    const cases = [
        ...(['PACK', 'SHIP', 'DELIVER'] as const).map((platform) => ({
          orderId: command.orderId,
          platform,
        })),
        { orderId: command.orderId, kind: 'task' },
      ],
      result = goldenSourceStatusOracle('source', {
        lines: snapshot.lines.map((row) => ({ ...row, orderId: command.orderId })),
        cases,
      });
    for (let i = 0; i < result.length; i++) {
      expect(result[i]!.requests).toHaveLength(1);
      const value = cases[i]!,
        platform = 'platform' in value ? value.platform : 'PACK';
      expect(result[i]!.requests[0]!).toMatchObject({
        path: '/store-order/status',
        body: sourceStatusBody(snapshot, platform),
        timeout: 10,
        headerNames: ['Content-Type', 'x-api-key'],
      });
    }
  });
  it('records the source false-queue acknowledgement hazard on missing config, HTTP failure and timeout', () => {
    const result = goldenSourceStatusOracle('source', {
      lines: snapshot.lines.map((row) => ({ ...row, orderId: command.orderId })),
      cases: [
        { orderId: command.orderId, platform: 'PACK', missingEndpoint: true },
        { orderId: command.orderId, platform: 'PACK', httpStatus: 400 },
        { orderId: command.orderId, platform: 'PACK', transportError: true },
      ],
    });
    expect(result.map((row) => row.callback)).toEqual(
      Array.from({ length: 3 }, () => ({
        status: 200,
        message: 'Request has been queued for processing',
      })),
    );
    expect(result[0]!.requests).toEqual([]);
  });
});
