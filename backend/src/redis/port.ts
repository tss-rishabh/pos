/**
 * The narrow Redis surface used by authentication and sessions.
 *
 * Every command here maps one-to-one onto a Redis command, so the production client
 * (`node-client.ts`) sends exactly these commands and the in-process port (`memory.ts`)
 * implements exactly these semantics. Lua scripts carry a JavaScript twin so the
 * in-process port can run them atomically without a Lua interpreter.
 *
 * Production Redis must run with `maxmemory-policy noeviction`: OTP lockouts, retry
 * pauses and sessions are security state and must never be evicted under memory pressure.
 */
export interface SetOptions {
  /** Expire after this many seconds (SET … EX). */
  EX?: number;
  /** Expire after this many milliseconds (SET … PX). */
  PX?: number;
  /** Keep the current TTL (SET … KEEPTTL). */
  KEEPTTL?: true;
  /** Only set a missing key (SET … NX). */
  NX?: true;
  /** Only set an existing key (SET … XX). */
  XX?: true;
}
export type MultiCommand =
  | { command: 'SET'; key: string; value: string; options?: SetOptions }
  | { command: 'INCR'; key: string }
  | { command: 'DEL'; keys: string[] }
  | { command: 'LREM'; key: string; count: number; value: string }
  | { command: 'LPUSH'; key: string; value: string }
  | { command: 'EXPIRE'; key: string; seconds: number };
/** `OK`/`null` for SET, integers for INCR/DEL/LREM/LPUSH/EXPIRE. */
export type MultiReply = string | number | null;
/** Synchronous view of the keyspace used by the JavaScript twin of a Lua script. */
export interface ScriptStore {
  get(key: string): string | null;
  /** `ttlMs` undefined clears the TTL, `'keep'` keeps it. */
  set(key: string, value: string, ttlMs?: number | 'keep'): void;
  del(key: string): number;
  exists(key: string): boolean;
  pTtl(key: string): number;
}
export interface RedisScript<Result> {
  readonly name: string;
  readonly lua: string;
  /** Same semantics as `lua`; used only by the in-process port. */
  emulate(store: ScriptStore, keys: readonly string[], args: readonly string[]): unknown;
  /** Validates the raw reply. A malformed reply is a store failure, never a decision. */
  parse(reply: unknown): Result;
}
export interface RedisPort {
  get(key: string): Promise<string | null>;
  mGet(keys: readonly string[]): Promise<(string | null)[]>;
  /** True when Redis replied OK (false for an NX/XX miss). */
  set(key: string, value: string, options?: SetOptions): Promise<boolean>;
  del(keys: readonly string[]): Promise<number>;
  exists(key: string): Promise<boolean>;
  /** Milliseconds left; -2 when missing, -1 without TTL (PTTL). */
  pTtl(key: string): Promise<number>;
  /** MULTI … EXEC. Replies are in command order. */
  multi(commands: readonly MultiCommand[]): Promise<MultiReply[]>;
  /** Non-blocking SCAN MATCH (never KEYS). */
  scanKeys(pattern: string): Promise<string[]>;
  lRem(key: string, count: number, value: string): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  run<Result>(
    script: RedisScript<Result>,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<Result>;
  close(): Promise<void>;
}
export function defineScript<Result>(script: RedisScript<Result>): RedisScript<Result> {
  return Object.freeze(script);
}
