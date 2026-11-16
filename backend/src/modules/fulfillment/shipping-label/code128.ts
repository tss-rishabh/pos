import { AppError } from '../../../domain/errors.js';
import { code128Patterns } from './code128-patterns.js';

type CodeSet = 0 | 1 | 2;
interface Step {
  target: CodeSet;
  consumed: 1 | 2;
  value: number;
}
const targets: readonly CodeSet[] = [2, 1, 0],
  starts = [103, 104, 105] as const,
  switches = [101, 100, 99] as const;
/** Bounded, minimum-symbol Code128 A/B/C planner. No runtime script or CDN. */
export function shippingCode128(value: string) {
  if (!/^[\x00-\x7f\xcf]{1,255}$/.test(value))
    throw new AppError(
      409,
      'SHIPPING_BARCODE_RECONCILIATION_REQUIRED',
      'The shipping barcode requires reconciliation before printing.',
    );
  const costs = Array.from({ length: value.length + 1 }, () => [0, 0, 0]),
    steps: Step[][] = Array.from({ length: value.length }, () => []);
  for (let position = value.length - 1; position >= 0; position--) {
    const character = value.charCodeAt(position);
    for (const current of targets) {
      let best = Number.POSITIVE_INFINITY,
        chosen: Step | undefined;
      for (const target of [current, ...targets.filter((candidate) => candidate !== current)]) {
        const fnc1 = character === 207,
          numeric = /^\d{2}$/.test(value.slice(position, position + 2));
        if (!fnc1 && (target === 0 ? character > 95 : target === 1 ? character < 32 : !numeric))
          continue;
        const consumed = target === 2 && !fnc1 ? 2 : 1,
          nextCost = costs[position + consumed]![target]! + 1 + (target === current ? 0 : 1);
        if (nextCost >= best) continue;
        best = nextCost;
        chosen = {
          target,
          consumed,
          value: fnc1
            ? 102
            : target === 2
              ? Number(value.slice(position, position + 2))
              : target === 0 && character < 32
                ? character + 64
                : character - 32,
        };
      }
      if (!chosen)
        throw new AppError(
          409,
          'SHIPPING_BARCODE_RECONCILIATION_REQUIRED',
          'The shipping barcode requires reconciliation before printing.',
        );
      costs[position]![current] = best;
      steps[position]![current] = chosen;
    }
  }
  let set: CodeSet = targets.reduce(
      (best, candidate) => (costs[0]![candidate]! < costs[0]![best]! ? candidate : best),
      2 as CodeSet,
    ),
    position = 0;
  const codes: number[] = [starts[set]];
  while (position < value.length) {
    const next = steps[position]![set]!;
    if (next.target !== set) codes.push(switches[next.target]);
    codes.push(next.value);
    position += next.consumed;
    set = next.target;
  }
  const checksum = codes.reduce((total, code, index) => total + code * (index || 1), 0) % 103;
  codes.push(checksum, 106);
  return { codes, modules: codes.map((code) => code128Patterns[code]!).join('') };
}
export function shippingCode128Svg(value: string, displayValue = true) {
  const { modules } = shippingCode128(value),
    quiet = 10,
    height = displayValue ? 75 : 54,
    width = modules.length + quiet * 2;
  const bars: string[] = [];
  let position = 0;
  while (position < modules.length) {
    if (modules[position] !== '1') {
      position++;
      continue;
    }
    const start = position;
    while (modules[position] === '1') position++;
    bars.push(`<rect x="${start + quiet}" y="0" width="${position - start}" height="50"/>`);
  }
  const escaped = value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replace(/[\x00-\x1f\x7f\xcf]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escaped}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="crispEdges"><g fill="#000">${bars.join('')}</g>${displayValue ? `<text x="${width / 2}" y="68" text-anchor="middle" font-family="monospace" font-size="12">${escaped}</text>` : ''}</svg>`;
}
