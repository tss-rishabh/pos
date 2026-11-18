import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { AppError } from '../domain/errors.js';

const commonPasswords = new Set(
  gunzipSync(readFileSync(new URL('../../resources/auth/common-passwords.txt.gz', import.meta.url)))
    .toString('utf8')
    .split(/\r?\n/)
    .filter(Boolean),
);
export type PasswordAccount = {
  username: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
};
export type PasswordProblem =
  | 'password_too_similar'
  | 'password_too_short'
  | 'password_too_common'
  | 'password_entirely_numeric';
// Python str.strip() and re's Unicode word classes, as used by Django 4.2.5.
const whitespace =
  '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const strip = (value: string) =>
  value.replace(new RegExp(`^${whitespace}+|${whitespace}+$`, 'gu'), '');
function similarity(one: string, two: string) {
  const first = Array.from(one),
    second = Array.from(two);
  const counts = new Map<string, number>();
  for (const character of second) counts.set(character, (counts.get(character) || 0) + 1);
  let matched = 0;
  for (const character of first) {
    const remaining = counts.get(character) || 0;
    if (remaining) {
      matched++;
      counts.set(character, remaining - 1);
    }
  }
  return first.length + second.length ? (2 * matched) / (first.length + second.length) : 1;
}
export function passwordProblems(password: string, account: PasswordAccount): PasswordProblem[] {
  const lower = password.toLowerCase();
  const problems: PasswordProblem[] = [];
  for (const value of [account.username, account.first_name, account.last_name, account.email]) {
    if (!value) continue;
    const text = value.toLowerCase();
    if ([...text.split(/[^\p{L}\p{N}_]+/u), text].some((part) => similarity(lower, part) >= 0.7)) {
      problems.push('password_too_similar');
      break;
    }
  }
  if (Array.from(password).length < 8) problems.push('password_too_short');
  if (commonPasswords.has(strip(lower))) problems.push('password_too_common');
  // Nd plus Unicode characters with Numeric_Type=Digit (not every numeric symbol).
  if (
    password.length &&
    Array.from(password).every(
      (character) =>
        /\p{Nd}/u.test(character) ||
        /[²³¹\u1369-\u1371\u19da\u2070\u2074-\u2079\u2080-\u2089\u2460-\u2468\u2474-\u247c\u2488-\u2490\u24ea\u24f5-\u24fd\u24ff\u2776-\u277e\u2780-\u2788\u278a-\u2792\u{10a40}-\u{10a43}\u{10e60}-\u{10e68}\u{11052}-\u{1105a}\u{1f100}-\u{1f10a}]/u.test(
          character,
        ),
    )
  )
    problems.push('password_entirely_numeric');
  return problems;
}
export function assertPasswordPolicy(password: string, account: PasswordAccount) {
  const problems = passwordProblems(password, account);
  if (problems.length)
    throw new AppError(
      400,
      'PASSWORD_POLICY_REJECTED',
      'Use at least eight characters, avoid common or entirely numeric passwords, and avoid your personal information.',
    );
}
