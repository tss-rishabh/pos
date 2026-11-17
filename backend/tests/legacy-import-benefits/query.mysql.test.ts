import { describe, expect, it } from 'vitest';
import { explainBenefitQueryProposal } from '../../tools/legacy-import-benefits/query-proposal.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('source benefit DBA index proposal on generated native data', () => {
  it('keeps exact full-width/duplicate results while replacing full log scan with a bound order lookup', async () => {
    const result = await explainBenefitQueryProposal(template!);
    expect(result.responsesEqual).toBe(true);
    expect(result.matchedRows).toEqual({ assignments: 67, singleLog: 1, duplicateLogs: 2 });
    expect(['PRIMARY', null]).toContain(result.before.logs.index);
    expect(result.before.logs.maximumPlanRows).toBeGreaterThan(10000);
    expect(result.after.logs.index).toBe('ix_order_coupon_log_order_id');
    expect(result.after.logs.estimatedRows).toBe(1);
    expect(result.after.assignments.index).toBe('ix_coupons_users_user_coupon_id');
    expect(result.after.assignments.maximumPlanRows).toBeLessThan(
      result.before.assignments.maximumPlanRows,
    );
  }, 15000);
});
