import { describe, expect, it } from 'vitest';
import { jobClaimer, jobKeys } from '../../src/jobs/queue.js';
import type { RedisCommands } from '../../src/jobs/redis.js';

// W26: UAT Redis (shared with the legacy Celery broker) is 6.0.16, where LMOVE/BLMOVE (6.2+)
// are unknown commands and every claim failed. The claimer must use only Redis 6.0 commands.
describe('job claimer uses Redis 6.0 list commands', () => {
  it('RPOPLPUSH over each queue, then one BRPOPLPUSH, right to left', async () => {
    const sent: string[][] = [];
    let ready = ['job-2'];
    const fake = {
      send: async (command: string[]) => {
        sent.push(command);
        if (
          command[0] === 'RPOPLPUSH' &&
          command[1] === jobKeys.queue('export_queue') &&
          ready.length
        ) {
          const [job] = ready;
          ready = [];
          return job;
        }
        return null;
      },
    } as unknown as RedisCommands;
    const claim = jobClaimer(fake, ['core', 'export_queue'], 0.25);
    expect(await claim('w1')).toBe('job-2');
    expect(await claim('w1')).toBeNull();
    expect(sent.map((command) => command[0])).toEqual([
      'RPOPLPUSH',
      'RPOPLPUSH',
      'RPOPLPUSH',
      'RPOPLPUSH',
      'BRPOPLPUSH',
    ]);
    expect(sent.at(-1)).toEqual([
      'BRPOPLPUSH',
      jobKeys.queue('export_queue'),
      jobKeys.inflight('w1'),
      '0.25',
    ]);
    expect(sent.flat().some((part) => /^B?LMOVE$/.test(part))).toBe(false);
  });
});
