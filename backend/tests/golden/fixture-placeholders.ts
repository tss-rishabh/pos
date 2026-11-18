import type { GoldenOptions } from './load.js';

/**
 * Placeholder tokens for an oracle that read the per-run isolated MySQL
 * fixture. Captures replaced the fixture URL, then its schema name, with
 * these tokens; replay substitutes the live values back.
 */
export function fixturePlaceholders(url: string): GoldenOptions {
  return {
    placeholders: {
      '<fixture-database-url>': url,
      '<fixture-schema>': decodeURIComponent(new URL(url).pathname.slice(1)),
    },
  };
}
