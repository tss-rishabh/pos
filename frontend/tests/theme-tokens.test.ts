import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard for the TSS brand theme: colours live only as tokens on :root in src/styles.css. Every
 * stylesheet and component refers to them through var(--token), so a hardcoded colour fails here.
 */
const root = join(import.meta.dirname, '..');
const sourceDir = join(root, 'src');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
const hex = /(?<![\w&])#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?(?![\w-])/gi;
const functional = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;
const named =
  /(?<![\w-])(?:white|black|red|green|blue|gray|grey|orange|yellow|purple)(?=\s*[;,)!}])/gi;
const tokens = (css: string) => {
  const start = css.indexOf(':root {');
  return { start, end: css.indexOf('\n}', start) };
};

describe('theme tokens', () => {
  const stylesheet = readFileSync(join(sourceDir, 'styles.css'), 'utf8');
  const block = tokens(stylesheet);
  const tokenBlock = stylesheet.slice(block.start, block.end);

  it('defines the brand palette on :root', () => {
    for (const [token, value] of [
      ['--tss-red', '#ed3833'],
      ['--tss-red-deep', '#d40709'],
      ['--charade', '#2c2d37'],
      ['--navy', '#282d3f'],
      ['--white', '#ffffff'],
      ['--athens-gray', '#f8f8f9'],
      ['--teal', '#148c8d'],
      ['--orange', '#e76a52'],
      ['--purple', '#894db3'],
      ['--success', '#1e9053'],
      ['--success-bright', '#4caf50'],
      ['--error', '#dd231d'],
      ['--warning', '#ff6813'],
      ['--gold', '#e7ae1a'],
      ['--gold-bright', '#ffbe27'],
    ] as const)
      expect(tokenBlock).toMatch(new RegExp(`\\s${token}: ${value};`));
    expect(tokenBlock).toContain("--font-body: 'Source Sans Pro'");
    expect(tokenBlock).toContain('--font-display: Montserrat');
    expect(tokenBlock).toContain("--font-ui: 'Open Sans'");
  });

  it('uses no hardcoded colours outside the :root token block', () => {
    const offenders: string[] = [];
    for (const file of files(sourceDir)) {
      if (!/\.(css|ts|tsx)$/.test(file) || file.endsWith('fonts.css')) continue;
      let text = readFileSync(file, 'utf8');
      if (file.endsWith(join('src', 'styles.css')))
        text = text.slice(0, block.start) + text.slice(block.end);
      // Comments may name colours in prose.
      text = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const patterns = file.endsWith('.css') ? [hex, functional, named] : [hex, functional];
      for (const pattern of patterns)
        for (const match of text.matchAll(pattern))
          offenders.push(`${relative(root, file)}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('refers only to tokens that are defined', () => {
    const defined = new Set([...tokenBlock.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));
    const missing = new Set<string>();
    for (const file of files(sourceDir)) {
      if (!/\.(css|ts|tsx)$/.test(file)) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(/var\((--[a-z0-9-]+)\)/g))
        if (!defined.has(match[1]!)) missing.add(`${relative(root, file)}: ${match[1]}`);
    }
    expect([...missing]).toEqual([]);
  });
});
