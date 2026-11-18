/** Executes the unchanged pinned global scripts; only browser/clock bridges are fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { z } from 'zod';
const pin = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a';
const expiryBody = z.object({
  expiring_soon: z.array(
    z.object({
      order_id: z.number(),
      type: z.enum(['pending', 'accepted']),
      expires_at: z.string(),
    }),
  ),
  banner_counts: z.object({ unaccepted: z.number(), unpacked: z.number(), packed: z.number() }),
});

export function sourceClientEvidence(source: string, original: unknown, now: number) {
  const payload = expiryBody.parse(original);
  const hashes: Record<string, string> = {};
  const read = (path: string) => {
    const raw = execFileSync('git', ['-C', source, 'show', `${pin}:${path}`]);
    hashes[path] = createHash('sha256').update(raw).digest('hex');
    return raw.toString('utf8');
  };
  const settings = read('POSAdmin/settings.py');
  assert(
    settings.includes(
      'HL_EXPIRY_POLL_INTERVAL_MS  = int(ENV.get("HL_EXPIRY_POLL_INTERVAL_MS", 60000))',
    ),
  );
  assert(settings.includes('ENV.get("DAY_CLOSE_NAG_INTERVAL_MINUTES", 10)'));
  const checks: string[] = [];
  for (const path of [
    'users/templates/admin/layouts/base.html',
    'users/templates/admin/layouts/base_no_sidebar_navbar.html',
  ]) {
    const template = read(path);
    const extract = (marker: string) => {
      const markerAt = template.indexOf(marker);
      assert(markerAt >= 0);
      const start = template.lastIndexOf('<script>', markerAt);
      assert(start >= 0);
      const end = template.indexOf('</script>', markerAt);
      assert(end >= 0);
      return template.slice(start + '<script>'.length, end);
    };
    let clock = now;
    class SourceHostDate extends Date {
      constructor(value?: string | number) {
        // Explicit source browser host-IST seam. Candidate is separately checked
        // in UTC/Los_Angeles and must not depend on its host calendar/zone.
        super(
          value === undefined
            ? clock
            : typeof value === 'string' &&
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
              ? value + '+05:30'
              : value,
        );
      }
      static now() {
        return clock;
      }
    }
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    };
    const popups: { title: string; html: string }[] = [];
    const intervals: number[] = [];
    let response = payload;
    const element = {
      show() {
        return element;
      },
      hide() {
        return element;
      },
      text() {
        return element;
      },
      removeClass() {
        return element;
      },
      addClass() {
        return element;
      },
    };
    const jquery = Object.assign(() => element, {
      ajax: (options: { success: (value: unknown) => void }) => options.success(response),
    });
    const window: Record<string, unknown> = {};
    const expiry = extract("localStorage.getItem('hl_alerted_keys')").replace(
      /{{\s*hl_expiry_poll_interval_ms\s*}}/g,
      '60000',
    );
    assert(!expiry.includes('{{') && !expiry.includes('{%'));
    vm.runInNewContext(
      expiry,
      {
        Date: SourceHostDate,
        localStorage: storage,
        window,
        $: jquery,
        Swal: {
          fire: (value: unknown) =>
            popups.push(z.object({ title: z.string(), html: z.string() }).parse(value)),
        },
        setInterval: (_callback: unknown, interval: number) => intervals.push(interval),
      },
      { timeout: 1000 },
    );
    assert.deepEqual(intervals, [60000]);
    assert.equal(popups.length, 1);
    assert.equal(popups[0]?.title, 'Orders Expiring Soon');
    assert(popups[0]?.html.includes('1</b> order(s) need acceptance'));
    assert(popups[0]?.html.includes('1</b> order(s) will be'));
    const refresh = window.hlRefreshBanner;
    assert.equal(typeof refresh, 'function');
    if (typeof refresh !== 'function') throw new Error('Pinned source refresh unavailable');
    refresh();
    assert.equal(popups.length, 1);
    clock += 16 * 60000;
    refresh();
    assert.equal(popups.length, 2);
    assert.equal(popups[1]?.title, 'Urgent: Action Required');
    response = { ...payload, expiring_soon: [] };
    refresh();
    assert.deepEqual(JSON.parse(stored.get('hl_alerted_keys') || '{}'), {});
    checks.push(`${path}:grouped-30-5-persisted-dedup-cleanup-default-interval`);

    if (!template.includes('var DAY_CLOSE_NAG_MS =')) {
      assert.equal(path, 'users/templates/admin/layouts/base_no_sidebar_navbar.html');
      checks.push(`${path}:no-day-close-nag-in-pinned-source`);
      continue;
    }

    clock = now;
    stored.clear();
    let hidden = true,
      reads = 0;
    const confirms: { onDestroy: () => void }[] = [];
    const events = new Map<string, () => void>();
    let tick: (() => void) | undefined;
    const dayJquery = Object.assign(
      (ready: unknown) => {
        if (typeof ready === 'function') ready();
      },
      {
        get: () => {
          reads++;
          return {
            done: (done: (value: unknown) => void) =>
              done({
                show: true,
                is_stale: true,
                close_date: '18-11-2026',
                url: '/source/day-close',
              }),
          };
        },
        confirm: (value: { title: string; onDestroy: () => void }) => {
          assert.equal(value.title, 'Day Close needs redoing');
          confirms.push(value);
        },
      },
    );
    const day = extract('var DAY_CLOSE_NAG_MS =')
      .replace(/{{\s*day_close_nag_interval_ms\s*}}/g, '600000')
      .replace(/{{\s*request.user.id\s*}}/g, '1')
      .replace(/{{\s*check_in_store.0\s*}}/g, '1')
      .replace(/{%\s*url 'ajax_day_close_nag'\s*%}/g, '/source/day-close-prompt');
    assert(!day.includes('{{') && !day.includes('{%'));
    vm.runInNewContext(
      day,
      {
        Date: SourceHostDate,
        localStorage: storage,
        $: dayJquery,
        document: {
          get hidden() {
            return hidden;
          },
          addEventListener: (name: string, fn: () => void) => events.set(name, fn),
        },
        window: { location: { href: '' } },
        setInterval: (fn: () => void, interval: number) => {
          assert.equal(interval, 600000);
          tick = fn;
        },
      },
      { timeout: 1000 },
    );
    assert.equal(reads, 0);
    hidden = false;
    events.get('visibilitychange')?.();
    assert.equal(confirms.length, 1);
    clock = now + 30000;
    confirms[0]?.onDestroy();
    clock = now + 600001;
    tick?.();
    assert.equal(confirms.length, 1);
    clock = now + 630001;
    tick?.();
    assert.equal(confirms.length, 2);
    checks.push(`${path}:foreground-stale-prompt-dismissal-buys-full-interval`);
  }
  return {
    sourceCommit: pin,
    hashes,
    checks,
    boundaries: [
      'Source browser host IST/clock/DOM/jQuery/Swal bridges are explicit fixtures.',
      'Candidate native HTTP and financial services are not replaced.',
      'No whole-template or complete finance-route certification.',
    ],
  };
}
