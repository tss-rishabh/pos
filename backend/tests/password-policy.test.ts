import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { passwordProblems } from '../src/auth/password-policy.js';
import { goldenSpawnResult } from './golden/load.js';

describe('source-configured Django 4.2.5 password validation', () => {
  it('matches the original dependency validators over Unicode, common-password and similarity cases', () => {
    const accounts = [
      {
        username: 'clerk@example.test',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'clerk@example.test',
      },
      { username: 'İ_東京', first_name: 'Zoë', last_name: 'Σίγμα', email: null },
    ];
    const passwords = [
      'password',
      'password123',
      '12345678',
      '²³¹²³¹²³',
      '①②③④⑤⑥⑦⑧',
      '⑩⑩⑩⑩⑩⑩⑩⑩',
      '𐩀𐩁𐩂𐩃𐩀𐩁𐩂𐩃',
      '𞥐𞥑𞥒𞥓𞥔𞥕𞥖𞥗',
      '𝟘𝟙𝟚𝟛𝟜𝟝𝟞𝟟',
      '😀😀😀😀😀😀😀',
      '😀😀😀😀😀😀😀😀',
      'Lovelace',
      'ecalevoL',
      'clerk!',
      'clerk@example.test',
      'Ada Lovelace',
      'A completely independent passphrase 42!',
      '\u0085PASSWORD\u0085',
      '\ufeffPASSWORD\ufeff',
      '',
      '   ',
      'İ_東京İ_東京',
      'ΣΊΓΜΑΣΊΓΜΑ',
      'ZoëZoëZoë',
      'x'.repeat(512),
    ];
    let state = 71;
    const alphabet = Array.from('AdaLo1!éΣ東_ ');
    for (let index = 0; index < 150; index++) {
      let text = '';
      for (let position = 0; position < index % 27; position++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        text += alphabet[state % alphabet.length]!;
      }
      passwords.push(text);
    }
    const cases = accounts.flatMap((account) =>
      passwords.map((password) => ({ account, password })),
    );
    const original = goldenSpawnResult('core', 'password-policy', JSON.stringify(cases));
    expect(original.status, original.stderr).toBe(0);
    expect(cases.map(({ password, account }) => passwordProblems(password, account))).toEqual(
      JSON.parse(original.stdout) as unknown,
    );
  });
  it('pins the original validation source, password list and license', () => {
    const manifest = JSON.parse(readFileSync('resources/auth/manifest.json', 'utf8')) as Record<
      string,
      { url: string; sha256: string }
    >;
    for (const [path, entry] of Object.entries(manifest))
      expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(entry.sha256);
  });
});
