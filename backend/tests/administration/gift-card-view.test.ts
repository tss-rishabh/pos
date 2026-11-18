import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { goldenStdout } from '../golden/load.js';

function oracle(cases: unknown[]) {
  return z
    .object({ cases: z.array(z.unknown()) })
    .parse(
      JSON.parse(
        goldenStdout('administration', 'gift-card-view', JSON.stringify({ cases })),
      ) as unknown,
    ).cases;
}
describe('actual pinned gift batch view behavior', () => {
  it('preserves source print/block values and confirms those endpoints only mutate collection flags', () => {
    const rows = [
      {
        id: 7,
        is_completed: 1,
        is_printed: 0,
        is_block: 0,
        size: 2,
        message: 'Fixture',
        filename: 'fixture.zip',
      },
    ];
    const results = oracle([
      { operation: 'print', rows, input: { collection: '7' } },
      { operation: 'block', rows, input: { collection: '7', opr: 'block' } },
      {
        operation: 'block',
        rows: [{ ...rows[0]!, is_block: 1 }],
        input: { collection: '7', opr: 'active' },
      },
      { operation: 'print', rows, input: { collection: '999' } },
    ]);
    expect(results[0]).toMatchObject({
      response: { status: 'success', message: 'Marked as printed' },
      rows: [{ ...rows[0]!, is_printed: 1 }],
      generationCalls: [],
    });
    expect(results[1]).toMatchObject({
      response: { status: 'success', message: 'Marked as block' },
      rows: [{ ...rows[0]!, is_block: 1 }],
      generationCalls: [],
    });
    expect(results[2]).toMatchObject({
      response: { status: 'success', message: 'Marked as active' },
      rows: [{ ...rows[0]!, is_block: 0 }],
      generationCalls: [],
    });
    expect(results[3]).toMatchObject({
      response: { status: 'failed', message: 'Please provide valid data' },
      rows,
      generationCalls: [],
    });
  });
  it('records source direct generation and unsafe missing-email/negative-size behavior as corrected gaps', () => {
    const results = oracle([
      {
        operation: 'generate',
        input: { size: '2', message: 'Fixture' },
        email: 'pos.fixture@example.test',
      },
      { operation: 'generate', input: { size: '2', message: 'Fixture' }, email: '' },
      { operation: 'generate', input: { size: '-1', message: 'Fixture' } },
    ]);
    expect(results[0]).toMatchObject({
      response: { status: 'success' },
      rows: [{ id: 77, size: 2, message: 'Fixture', created_by: 1 }],
      generationCalls: [[77, 2, '9999999999', 'fixture@example.test']],
    });
    expect(results[1]).toMatchObject({
      response: { status: 'failed', message: 'Not Eligible to generate the GCs.' },
      rows: [{ id: 77 }],
      generationCalls: [],
    });
    expect(results[2]).toMatchObject({
      response: { status: 'success' },
      rows: [{ size: -1 }],
      generationCalls: [[77, -1, '9999999999', 'fixture@example.test']],
    });
  });
});
