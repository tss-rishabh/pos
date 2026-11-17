import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { originError, originDigest, originHashSchema, sameOriginHash } from './contracts.js';
import {
  verifyOriginHistorySnapshot,
  originHistoryWitnessSchema,
  sameHistoryWitness,
  type OriginHistorySnapshot,
  type OriginHistoryWitness,
} from './history-contracts.js';
export interface OriginHistorySourcePort {
  capture(
    input: { customerId: string; witness: OriginHistoryWitness },
    signal: AbortSignal,
  ): Promise<OriginHistorySnapshot>;
}
/** Background only. Explicit readonly origin credentials enter private stdin,
 * never argv/logs/env, and no DB connection/lock can cross a warehouse call. */
export function originHistorySource(options: {
  python: string;
  modulePath: string;
  sourceUrl: string;
  caFile: string;
  allowLocalPlaintext?: boolean;
  sourceSchema: string;
  sourceServerUuid: string;
  captureKey: string;
  triggerDefiner: string;
  auditDefiner: string;
  administrators: readonly string[];
  timeoutMs: number;
}): OriginHistorySourcePort {
  if (
    !options.python.startsWith('/') ||
    !options.modulePath.startsWith('/') ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1000 ||
    options.timeoutMs > 25000
  )
    throw originError('SCREENING_ORIGIN_HISTORY_SOURCE_CONFIGURATION');
  return {
    async capture(input, signal) {
      signal.throwIfAborted();
      if (
        input.witness.sourceSchema !== options.sourceSchema ||
        input.witness.sourceServerUuid !== options.sourceServerUuid
      )
        throw originError('SCREENING_ORIGIN_HISTORY_SOURCE_ORIGIN_CHANGED');
      const module = resolve(options.modulePath),
        directory = dirname(module);
      const child = spawn(options.python, ['-B', '-u', module, '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          LANG: 'C.UTF-8',
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONPATH: [
            directory,
            resolve(directory, '../legacy-order-imports'),
            resolve(directory, '../public-screening-writer'),
          ].join(':'),
          POS_SCREENING_ORIGIN_HISTORY_DEFINER: options.triggerDefiner,
          POS_SCREENING_ORIGIN_HISTORY_AUDIT_DEFINER: options.auditDefiner,
          POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES: JSON.stringify(options.administrators),
        },
      });
      const chunks: Buffer[] = [];
      let size = 0,
        failed = false;
      const stop = () => {
          failed = true;
          child.kill('SIGKILL');
        },
        timer = setTimeout(stop, options.timeoutMs);
      signal.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (part: Buffer) => {
        size += part.length;
        if (size > 9000000) stop();
        else chunks.push(part);
      });
      // Deliberately drain, never print, raw Python/provider output.
      child.stderr.on('data', () => undefined);
      child.stdin.on('error', () => stop());
      child.stdin.end(
        JSON.stringify({
          customerId: input.customerId,
          witness: input.witness,
          captureKey: options.captureKey,
          sourceUrl: options.sourceUrl,
          caFile: options.caFile,
          allowLocalPlaintext: options.allowLocalPlaintext === true,
        }),
      );
      try {
        const code = await new Promise<number | null>((accept, reject) => {
          child.once('error', reject);
          child.once('close', accept);
        });
        if (code !== 0 || failed || signal.aborted) throw originError();
        const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          changed = z
            .object({
              changed: z
                .object({
                  customerId: z.string(),
                  expected: originHistoryWitnessSchema,
                  current: originHistoryWitnessSchema,
                  observedAt: z.number().int().positive().safe(),
                })
                .strict(),
              signature: originHashSchema,
            })
            .strict()
            .safeParse(raw);
        if (changed.success) {
          const value = changed.data.changed;
          if (
            value.customerId !== input.customerId ||
            !sameHistoryWitness(value.expected, input.witness) ||
            !sameOriginHash(
              changed.data.signature,
              originDigest(options.captureKey, 'history-head-change', value),
            )
          )
            throw originError();
          throw originError('SCREENING_ORIGIN_HISTORY_GENERATION_SUPERSEDED');
        }
        const snapshot = verifyOriginHistorySnapshot(raw, options.captureKey);
        if (
          snapshot.capture.customerId !== input.customerId ||
          !sameHistoryWitness(snapshot.capture.witness, input.witness)
        )
          throw originError('SCREENING_ORIGIN_HISTORY_CHANGED');
        return snapshot;
      } catch (error) {
        signal.throwIfAborted();
        if (
          error instanceof AppError &&
          error.code === 'SCREENING_ORIGIN_HISTORY_GENERATION_SUPERSEDED'
        )
          throw error;
        throw originError('SCREENING_ORIGIN_HISTORY_SOURCE_UNAVAILABLE');
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
      }
    },
  };
}
