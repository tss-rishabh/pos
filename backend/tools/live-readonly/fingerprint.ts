/**
 * Value-free statement fingerprints for the live read-only evidence (W16 round 3).
 *
 * `statementTemplate` rebuilds a statement from the guard's tokens with every string, number
 * and variable token replaced by `?`, and comments (including optimizer hints) dropped. Bound
 * values never reach the text in the first place (Drizzle sends `?` placeholders). The result is
 * the SQL shape only, so a failed statement can be named in the evidence without any row,
 * search or ID value. `assertValueFreeTemplate` re-derives the template and rejects anything
 * that is not already one.
 */
import { createHash } from 'node:crypto';
import type { PlanShape } from './plan-gate.js';
import { tokenize } from './sql-guard.js';

export interface FailedStatement {
  /** First 16 hex digits of SHA-256 over the template. */
  fingerprint: string;
  /** Error code only (for example `ER_QUERY_TIMEOUT` or `RO_PLAN_ROWS`). */
  code: string;
  /** The value-free SQL template; omitted when it would not pass `assertValueFreeTemplate`. */
  template?: string;
  /** The plan the gate saw before sending, when it EXPLAINed the statement. */
  plan?: PlanShape;
}

const templateCharacters = /^[A-Za-z0-9_ `.,()<>=!*+\-/?|&:^~]*$/;
export const maxTemplateLength = 8000;

export function statementTemplate(sql: string): string {
  const parts: string[] = [];
  for (const token of tokenize(sql)) {
    const text =
      token.kind === 'string' || token.kind === 'number' || token.kind === 'variable'
        ? '?'
        : token.kind === 'identifier'
          ? sql.slice(token.start, token.end)
          : token.value;
    parts.push(text);
  }
  return parts
    .join(' ')
    .replace(/\( /g, '(')
    .replace(/ ([),])/g, '$1')
    .replace(/ \. /g, '.');
}

export function templateFingerprint(template: string): string {
  return createHash('sha256').update(template).digest('hex').slice(0, 16);
}

/** True when `value` is a template: no quotes, no literal, nothing a re-tokenization changes. */
export function isValueFreeTemplate(value: string): boolean {
  if (value.length > maxTemplateLength || !templateCharacters.test(value)) return false;
  try {
    return statementTemplate(value) === value;
  } catch {
    return false;
  }
}

export function failedStatement(sql: string, code: string, plan?: PlanShape): FailedStatement {
  let template: string | undefined;
  try {
    template = statementTemplate(sql);
  } catch {
    template = undefined;
  }
  return {
    fingerprint: templateFingerprint(template ?? ''),
    code,
    ...(template && isValueFreeTemplate(template) ? { template } : {}),
    ...(plan ? { plan } : {}),
  };
}
