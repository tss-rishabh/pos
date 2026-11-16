import type { SnapshotRow } from './contracts';
/** DataTables 1.10 default smart search: literal words/quoted phrases over all displayed cells. */
export function filterCatalogSnapshot(rows: readonly SnapshotRow[], search: string) {
  const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const words = (escaped.match(/"[^"]+"|[^ ]+/g) || ['']).map((word) =>
    word.startsWith('"')
      ? (/^"(.*)"$/.exec(word)?.[1] ?? word).replace('"', '')
      : word.replace('"', ''),
  );
  const pattern = new RegExp('^(?=.*?' + words.join(')(?=.*?') + ').*$', 'i');
  return rows.filter((row) =>
    pattern.test(
      row
        .map((value) => value ?? '')
        .join('  ')
        .replace(/[\r\n\u2028]/g, ''),
    ),
  );
}
