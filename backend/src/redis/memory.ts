import type {
  MultiCommand,
  MultiReply,
  RedisPort,
  RedisScript,
  ScriptStore,
  SetOptions,
} from './port.js';

type Entry =
  | { kind: 'string'; value: string; expiresAt?: number }
  | {
      kind: 'list';
      items: string[];
      expiresAt?: number;
    };
/** Glob subset used by SCAN MATCH here: `*`, `?` and literal characters. */
function globMatcher(pattern: string): RegExp {
  let source = '^';
  for (const character of pattern)
    source +=
      character === '*'
        ? '.*'
        : character === '?'
          ? '.'
          : character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(source + '$', 's');
}
const wrongType = () =>
  new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
/**
 * In-process Redis with the exact semantics of the commands in `RedisPort`.
 * Used by the isolated demo workspace and by tests when no loopback `redis-server`
 * is available. Every call is synchronous inside, so MULTI and scripts are atomic.
 */
export function memoryRedisPort(now: () => number = Date.now): RedisPort & {
  /** Test helper: the raw value of a string key. */
  peek(key: string): string | null;
  keys(): string[];
} {
  const data = new Map<string, Entry>();
  function live(key: string): Entry | undefined {
    const entry = data.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= now()) {
      data.delete(key);
      return undefined;
    }
    return entry;
  }
  function string(key: string): string | null {
    const entry = live(key);
    if (!entry) return null;
    if (entry.kind !== 'string') throw wrongType();
    return entry.value;
  }
  function setValue(key: string, value: string, options: SetOptions = {}): boolean {
    const existing = live(key);
    if (options.NX && existing) return false;
    if (options.XX && !existing) return false;
    const expiresAt =
      options.EX !== undefined
        ? now() + options.EX * 1000
        : options.PX !== undefined
          ? now() + options.PX
          : options.KEEPTTL
            ? existing?.expiresAt
            : undefined;
    if (
      (options.EX !== undefined && options.EX <= 0) ||
      (options.PX !== undefined && options.PX <= 0)
    )
      throw new Error('ERR invalid expire time in set');
    data.set(key, { kind: 'string', value, ...(expiresAt === undefined ? {} : { expiresAt }) });
    return true;
  }
  function del(keys: readonly string[]): number {
    let removed = 0;
    for (const key of keys) if (live(key) && data.delete(key)) removed++;
    return removed;
  }
  function pTtl(key: string): number {
    const entry = live(key);
    if (!entry) return -2;
    return entry.expiresAt === undefined ? -1 : Math.max(0, entry.expiresAt - now());
  }
  function list(key: string): string[] | undefined {
    const entry = live(key);
    if (!entry) return undefined;
    if (entry.kind !== 'list') throw wrongType();
    return entry.items;
  }
  function lRem(key: string, count: number, value: string): number {
    const items = list(key);
    if (!items) return 0;
    let removed = 0;
    const limit = count === 0 ? Infinity : Math.abs(count);
    const order = count < 0 ? [...items.keys()].reverse() : [...items.keys()];
    const drop = new Set<number>();
    for (const index of order) {
      if (removed >= limit) break;
      if (items[index] === value) {
        drop.add(index);
        removed++;
      }
    }
    const next = items.filter((_, index) => !drop.has(index));
    if (next.length) data.set(key, { ...live(key)!, kind: 'list', items: next });
    else data.delete(key);
    return removed;
  }
  function execute(command: MultiCommand): MultiReply {
    switch (command.command) {
      case 'SET':
        return setValue(command.key, command.value, command.options) ? 'OK' : null;
      case 'INCR': {
        const current = string(command.key);
        if (current !== null && !/^-?\d+$/.test(current))
          throw new Error('ERR value is not an integer or out of range');
        const next = (current === null ? 0 : Number(current)) + 1;
        setValue(command.key, String(next), { KEEPTTL: true });
        return next;
      }
      case 'DEL':
        return del(command.keys);
      case 'LREM':
        return lRem(command.key, command.count, command.value);
      case 'LPUSH': {
        const items = list(command.key);
        if (items) items.unshift(command.value);
        else data.set(command.key, { kind: 'list', items: [command.value] });
        return list(command.key)!.length;
      }
      case 'EXPIRE': {
        const entry = live(command.key);
        if (!entry) return 0;
        entry.expiresAt = now() + command.seconds * 1000;
        return 1;
      }
    }
  }
  const scriptStore: ScriptStore = {
    get: string,
    set(key, value, ttlMs) {
      if (ttlMs === 'keep') setValue(key, value, { KEEPTTL: true });
      else if (ttlMs === undefined) setValue(key, value);
      else setValue(key, value, { PX: ttlMs });
    },
    del: (key) => del([key]),
    exists: (key) => live(key) !== undefined,
    pTtl,
  };
  return {
    get: async (key) => string(key),
    mGet: async (keys) =>
      keys.map((key) => {
        const entry = live(key);
        return entry?.kind === 'string' ? entry.value : null;
      }),
    set: async (key, value, options) => setValue(key, value, options),
    del: async (keys) => del(keys),
    exists: async (key) => live(key) !== undefined,
    pTtl: async (key) => pTtl(key),
    async multi(commands) {
      // Redis queues then runs every command; a runtime error affects only that command.
      return commands.map((command) => {
        try {
          return execute(command);
        } catch {
          return null;
        }
      });
    },
    async scanKeys(pattern) {
      const matcher = globMatcher(pattern);
      return [...data.keys()].filter((key) => live(key) && matcher.test(key));
    },
    lRem: async (key, count, value) => lRem(key, count, value),
    lRange: async (key, start, stop) => {
      const items = list(key) ?? [];
      const from = start < 0 ? Math.max(0, items.length + start) : start;
      const to = stop < 0 ? items.length + stop : stop;
      return items.slice(from, to + 1);
    },
    async run<Result>(
      script: RedisScript<Result>,
      keys: readonly string[],
      args: readonly string[],
    ) {
      return script.parse(script.emulate(scriptStore, keys, args));
    },
    async close() {},
    peek: (key) => {
      const entry = live(key);
      return entry?.kind === 'string' ? entry.value : null;
    },
    keys: () => [...data.keys()].filter((key) => live(key)),
  };
}
