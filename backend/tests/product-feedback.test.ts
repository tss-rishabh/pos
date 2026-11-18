import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  feedbackPage,
  feedbackSubmission,
  productFeedbackScope,
  sourceFeedbackOrder,
} from '../src/modules/product-feedback/contracts.js';
import { goldenStdout } from './golden/load.js';

describe('staff product feedback source contract', () => {
  it('executes source read rotation and all four source writes, preserving duplicate SKU occurrences', () => {
    const result = z
      .object({
        usersSha256: z.string().length(64),
        orderSha256: z.string().length(64),
        rotations: z.array(z.array(z.number().nullable())),
        created: z.array(
          z.object({
            user_id: z.string(),
            order_id: z.string(),
            prod_id: z.string(),
            product_rating_option_id: z.number(),
            rating: z.number(),
            platform: z.string(),
            comment: z.string(),
            is_default: z.number(),
          }),
        ),
        scopeVectors: z.number(),
      })
      .parse(JSON.parse(goldenStdout('core', 'product-feedback')));
    expect(result.rotations).toEqual([[], [0], [1], [0, 1, 2, 3, 0], [0, 7, null]]);
    for (const [i, rows] of [[], [0], [1], [0, 0, 1, 2, 3], [null, 0, 7]].entries())
      expect(sourceFeedbackOrder(rows)).toEqual(result.rotations[i]);
    expect(
      result.created.map((row) => [
        row.product_rating_option_id,
        row.rating,
        row.is_default,
        row.platform,
        row.comment,
      ]),
    ).toEqual([
      [0, 4.5, 1, 'WEB', 'café € <script>'],
      [1, 0, 0, 'WEB', ''],
      [2, 3.2, 0, 'WEB', ''],
      [3, 0, 0, 'WEB', ''],
    ]);
    expect(result.scopeVectors).toBe(2);
  });
  it('requires an overall rating, defaults optional ratings to zero and validates native text and tenths', () => {
    const base = {
      operationId: randomUUID(),
      expectedVersion: 1,
      productId: '9007199254740993',
      overall: 0,
    };
    expect(feedbackSubmission.parse(base)).toEqual({
      ...base,
      fit: 0,
      size: 0,
      quality: 0,
      comment: '',
    });
    expect(
      feedbackSubmission.parse({ ...base, overall: 4.1, comment: 'café € “fine”' }).overall,
    ).toBe(4.1);
    for (const patch of [
      { overall: undefined },
      { overall: 5.1 },
      { fit: 0.01 },
      { size: -1 },
      { quality: Infinity },
      { comment: 'x'.repeat(256) },
      { comment: '🙂' },
      { comment: '\u0000' },
      { customerId: '9' },
      { productId: '9223372036854775808' },
    ])
      expect(feedbackSubmission.safeParse({ ...base, ...patch }).success).toBe(false);
  });
  it('bounds page sizes and exact identifiers without lossy coercion or arbitrary extra fields', () => {
    expect(feedbackPage.parse({ limit: '25', after: '9007199254740993' })).toEqual({
      limit: 25,
      after: '9007199254740993',
    });
    expect(feedbackPage.safeParse({ limit: 51 }).success).toBe(false);
    expect(feedbackPage.safeParse({ after: '0' }).success).toBe(false);
    expect(
      productFeedbackScope.safeParse({
        storeId: '1',
        checkoutId: randomUUID(),
        customerId: '1',
        orderId: '9223372036854775808',
      }).success,
    ).toBe(false);
  });
});
