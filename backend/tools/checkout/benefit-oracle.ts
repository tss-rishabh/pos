import { execFileSync } from 'node:child_process';
import { z } from 'zod';

export interface BenefitOracleCase {
  asset: 'money' | 'points' | 'voucher';
  operation?: 0 | 1;
  amount?: string;
  platform?: string;
  reason?: string;
  expiry?: string;
  orderId?: string;
  productId?: string;
  balances?: { money?: number; points?: number; cashback?: number };
  histories?: {
    id: string;
    added_amt: number;
    used_amt: number;
    is_expired?: number;
    created_at?: string;
  }[];
}
const result = z.object({
  sourceSha256: z.literal('20f9910156aa3c427df759bdd26f4d19992a91f0a1ea1df915fa98eb3b2de349'),
  profile: z.enum(['legacy', 'proposed-wallet-v1']),
  cases: z.array(
    z.object({
      status: z.enum(['success', 'fail']),
      queries: z.array(z.string().max(50000)).max(100),
      histories: z.array(
        z.object({
          id: z.string(),
          added_amt: z.number().finite(),
          used_amt: z.number().finite(),
          is_expired: z.number().optional(),
          created_at: z.string().optional(),
        }),
      ),
      activities: z.array(z.object({ operatorId: z.literal(44), platform: z.string() })),
    }),
  ),
});
/** Controlled source fixture SQL only. Production code never imports this test harness. */
export function benefitOracle(
  cases: readonly BenefitOracleCase[],
  profile: 'legacy' | 'proposed-wallet-v1' = 'legacy',
) {
  if (!cases.length || cases.length > 1000) throw new Error('Bounded benefit cases required.');
  return result.parse(
    JSON.parse(
      execFileSync('python3', ['tools/checkout/benefit_oracle.py'], {
        input: JSON.stringify({ cases, profile }),
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 20000,
      }),
    ) as unknown,
  );
}
