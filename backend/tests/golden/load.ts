/**
 * Committed golden outputs captured from the pinned legacy source oracles
 * (backend-pos-web 78d5b63, CPython 3.10 / pinned toolchains) before the
 * Python, Go and PHP oracle runners were removed from this repository.
 *
 * Each golden file records every oracle invocation a test made, keyed by the
 * SHA-256 of the exact stdin bytes (and the logical arguments) the test sent.
 * A test that changes its oracle input no longer matches a recorded
 * invocation and fails loudly instead of silently comparing against a stale
 * expectation; the fix is a fresh capture, never an edited golden value.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const goldenRoot = dirname(fileURLToPath(import.meta.url));

const invocationSchema = z
  .object({
    inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
    args: z.array(z.string()),
    status: z.number().int().nullable(),
    output: z.unknown().optional(),
    stdout: z.string().optional(),
    stdoutBase64: z.string().optional(),
    stderr: z.string().optional(),
  })
  .strict()
  .refine(
    (value) =>
      [
        value.output !== undefined,
        value.stdout !== undefined,
        value.stdoutBase64 !== undefined,
      ].filter(Boolean).length <= 1,
    { message: 'An invocation stores at most one stdout representation.' },
  );

export const goldenFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    oracle: z.string().min(1),
    runtime: z.string().min(1),
    capturedAt: z.iso.datetime(),
    test: z.string().min(1),
    invocations: z.array(invocationSchema).min(1),
  })
  .strict();

export type GoldenFile = z.infer<typeof goldenFileSchema>;
export type GoldenInvocation = z.infer<typeof invocationSchema>;

const cache = new Map<string, GoldenFile>();

export function goldenPath(area: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/.test(area))
    throw new Error('Invalid golden area.');
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error('Invalid golden case name.');
  return join(goldenRoot, area, name + '.json');
}

export function loadGolden(area: string, name: string): GoldenFile {
  const path = goldenPath(area, name);
  const cached = cache.get(path);
  if (cached) return cached;
  const parsed = goldenFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  cache.set(path, parsed);
  return parsed;
}

export function goldenInputSha256(input: string | Uint8Array | undefined): string {
  return createHash('sha256')
    .update(input === undefined ? new Uint8Array() : input)
    .digest('hex');
}

/**
 * Per-run fixture identifiers (an isolated MySQL schema name or URL) that the
 * oracle saw. Captures store them as placeholder tokens; the live values are
 * substituted out of the input before hashing and back into the replayed
 * output, in insertion order (put a URL before the schema it contains).
 */
export type GoldenPlaceholders = Readonly<Record<string, string>>;
export interface GoldenOptions {
  placeholders?: GoldenPlaceholders;
}

function toPlaceholders(text: string, placeholders: GoldenPlaceholders | undefined): string {
  let value = text;
  for (const [token, live] of Object.entries(placeholders ?? {}))
    if (live) value = value.split(live).join(token);
  return value;
}

function fromPlaceholders(text: string, placeholders: GoldenPlaceholders | undefined): string {
  let value = text;
  for (const [token, live] of Object.entries(placeholders ?? {}).reverse())
    value = value.split(token).join(live);
  return value;
}

/** Find the recorded invocation for the exact stdin bytes and logical args. */
export function goldenInvocation(
  area: string,
  name: string,
  input?: string | Uint8Array,
  args?: readonly string[],
  options?: GoldenOptions,
): GoldenInvocation {
  const golden = loadGolden(area, name);
  const placeholders = options?.placeholders;
  const sha = goldenInputSha256(
    typeof input === 'string' ? toPlaceholders(input, placeholders) : input,
  );
  const keyArgs = args?.map((arg) => toPlaceholders(arg, placeholders));
  const match = golden.invocations.find(
    (entry) =>
      entry.inputSha256 === sha &&
      (keyArgs === undefined ||
        (entry.args.length === keyArgs.length && entry.args.every((arg, i) => arg === keyArgs[i]))),
  );
  if (!match)
    throw new Error(
      `Golden ${area}/${name} has no capture for input ${sha}; the oracle input changed and must be recaptured from the pinned source.`,
    );
  return match;
}

function stdoutText(entry: GoldenInvocation, options?: GoldenOptions): string {
  let text = '';
  if (entry.stdout !== undefined) text = entry.stdout;
  else if (entry.stdoutBase64 !== undefined)
    text = Buffer.from(entry.stdoutBase64, 'base64').toString('utf8');
  else if (entry.output !== undefined) text = JSON.stringify(entry.output);
  return fromPlaceholders(text, options?.placeholders);
}

/** Recorded stdout as text, as `execFileSync(..., { encoding: 'utf8' })` returned it. */
export function goldenStdout(
  area: string,
  name: string,
  input?: string | Uint8Array,
  args?: readonly string[],
  options?: GoldenOptions,
): string {
  const entry = goldenInvocation(area, name, input, args, options);
  if (entry.status !== 0)
    throw new Error(`Golden ${area}/${name} recorded a failed oracle run (${entry.status}).`);
  return stdoutText(entry, options);
}

/** Recorded stdout bytes, as `execFileSync(...)` without an encoding returned it. */
export function goldenStdoutBuffer(
  area: string,
  name: string,
  input?: string | Uint8Array,
  args?: readonly string[],
): Buffer {
  const entry = goldenInvocation(area, name, input, args);
  if (entry.status !== 0)
    throw new Error(`Golden ${area}/${name} recorded a failed oracle run (${entry.status}).`);
  if (entry.stdoutBase64 !== undefined) return Buffer.from(entry.stdoutBase64, 'base64');
  return Buffer.from(stdoutText(entry), 'utf8');
}

/** Recorded status/stdout/stderr, shaped like the fields tests read from `spawnSync`. */
export function goldenSpawnResult(
  area: string,
  name: string,
  input?: string | Uint8Array,
  args?: readonly string[],
  options?: GoldenOptions,
): { status: number | null; stdout: string; stderr: string } {
  const entry = goldenInvocation(area, name, input, args, options);
  return {
    status: entry.status,
    stdout: stdoutText(entry, options),
    stderr: fromPlaceholders(entry.stderr ?? '', options?.placeholders),
  };
}
