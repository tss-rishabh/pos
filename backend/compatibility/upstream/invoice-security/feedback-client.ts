export {};

const element = <T extends HTMLElement>(id: string, kind: { new (): T }): T => {
  const value = document.getElementById(id);
  if (!(value instanceof kind)) throw new Error('Feedback interface is unavailable.');
  return value;
};
const form = element('feedback-form', HTMLFormElement),
  score = element('feedback-score', HTMLSelectElement),
  load = element('feedback-load', HTMLButtonElement),
  submit = element('feedback-submit', HTMLButtonElement),
  check = element('feedback-check', HTMLButtonElement),
  comment = element('feedback-comment', HTMLTextAreaElement),
  options = element('feedback-options', HTMLDivElement),
  message = element('feedback-message', HTMLParagraphElement),
  editor = element('feedback-editor', HTMLFieldSetElement);
const contract = 'pos-feedback-proof-v1',
  endpoint = '/api/v1/post-order/nps/new-feedback';
let capability: string | null = null,
  busy = false,
  uncertain = false,
  done = false;
interface Option {
  id: number;
  optionName: string;
  rating?: number | null;
}
interface Survey {
  score: number | null;
  isExclusive: boolean | null;
  additionalFeedback: string | null;
  options: Option[];
  redirectTo: string | null;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const limitedText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;
function controls() {
  score.disabled = busy || uncertain || done || !capability;
  load.disabled = score.disabled || !score.value;
  editor.disabled = busy || uncertain || done || !capability;
  submit.disabled = editor.disabled || Boolean(editor.hidden);
  check.hidden = !uncertain;
  check.disabled = busy || !capability;
}
function notice(value: string) {
  message.textContent = value;
}
function finish(value: string) {
  done = true;
  editor.hidden = true;
  capability = null;
  notice(value);
}
function readSurvey(value: unknown): Survey {
  if (
    !record(value) ||
    !(
      value.score === null ||
      (Number.isInteger(value.score) && Number(value.score) >= 1 && Number(value.score) <= 10)
    ) ||
    !(value.isExclusive === null || typeof value.isExclusive === 'boolean') ||
    !(value.additionalFeedback === null || limitedText(value.additionalFeedback, 32000)) ||
    !(value.redirectTo === null || limitedText(value.redirectTo, 1024)) ||
    !Array.isArray(value.options) ||
    value.options.length > 200
  )
    throw new Error();
  const rows: Option[] = [];
  for (const row of value.options) {
    if (
      !record(row) ||
      typeof row.id !== 'number' ||
      !Number.isSafeInteger(row.id) ||
      row.id <= 0 ||
      !limitedText(row.optionName, 255) ||
      !(
        row.rating === undefined ||
        row.rating === null ||
        (typeof row.rating === 'number' &&
          Number.isFinite(row.rating) &&
          row.rating >= 1 &&
          row.rating <= 3)
      )
    )
      throw new Error();
    rows.push({ id: row.id, optionName: row.optionName, rating: row.rating });
  }
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error();
  return {
    score: value.score as number | null,
    isExclusive: value.isExclusive,
    additionalFeedback: value.additionalFeedback,
    options: rows,
    redirectTo: value.redirectTo,
  };
}
function responsePath(value: string) {
  const url = new URL(value, location.origin);
  if (
    url.origin !== location.origin ||
    url.search ||
    url.hash ||
    !['/api/v1/post-order/nps/feedback', '/api/v1/post-order/nps/thank-you'].includes(url.pathname)
  )
    throw new Error();
  return url.pathname;
}
async function request(method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<unknown> {
  if (!capability) throw new Error();
  const response = await fetch(
    endpoint + (method === 'GET' ? '?score=' + encodeURIComponent(score.value) : ''),
    {
      method,
      headers: {
        Authorization: capability,
        'X-POS-Feedback-Contract': contract,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(15000),
    },
  );
  if (response.status === 401) {
    capability = null;
    throw new Error();
  }
  if (!response.ok || response.headers.get('x-pos-feedback-contract') !== contract)
    throw new Error();
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  let bytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true }),
    parts: string[] = [];
  try {
    while (true) {
      const row = await reader.read();
      if (row.done) break;
      bytes += row.value.byteLength;
      if (bytes > 256 * 1024) throw new Error();
      parts.push(decoder.decode(row.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join('')) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function render(survey: Survey) {
  options.replaceChildren();
  for (const row of survey.options) {
    const label = document.createElement('label'),
      select = document.createElement('select');
    label.append(document.createTextNode(row.optionName));
    select.name = 'option-' + row.id;
    select.dataset.optionId = String(row.id);
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'Choose a rating';
    select.append(empty);
    for (const value of [1, 2, 3]) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = String(value);
      select.append(option);
    }
    if (row.rating !== null && row.rating !== undefined) select.value = String(row.rating);
    label.append(select);
    options.append(label);
  }
  comment.value = survey.additionalFeedback ?? '';
  editor.hidden = false;
}
async function readStatus() {
  if (busy || done) return;
  busy = true;
  controls();
  try {
    const survey = readSurvey(await request('GET'));
    if (survey.redirectTo) {
      const path = responsePath(survey.redirectTo);
      if (uncertain) {
        notice(
          'A score at least this high is recorded. The additional details of the interrupted submission could not be confirmed. No submission has been repeated.',
        );
      } else if (path.endsWith('/feedback'))
        finish('This order already has a score at least this high. Thank you for your feedback.');
      else finish('Thank you for your feedback.');
    } else if (uncertain) {
      notice(
        'The submission is still unconfirmed. No submission has been repeated. Please contact the store if you need help.',
      );
    } else {
      render(survey);
      notice('Share your shopping experience.');
    }
  } catch {
    notice(
      capability
        ? 'Feedback could not be loaded. Try checking again when connected.'
        : 'This feedback link is invalid or expired. Scan the original receipt again.',
    );
  } finally {
    busy = false;
    controls();
  }
}
function consumeFragment() {
  let next: string | null = null;
  try {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const values = fragment.getAll('feedback_proof');
    // Remove the capability before any API request. Never persist it.
    history.replaceState(null, '', location.pathname);
    if (
      values.length === 1 &&
      [...fragment.keys()].length === 1 &&
      values[0] &&
      values[0].length <= 4096 &&
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(values[0])
    )
      next = values[0];
  } catch {
    next = null;
  }
  if (busy || uncertain) {
    notice(
      'The original feedback is still being confirmed. Open another receipt in a separate tab so the two submissions stay separate.',
    );
    return;
  }
  capability = next;
  done = false;
  score.value = '';
  comment.value = '';
  options.replaceChildren();
  editor.hidden = true;
  notice(
    capability
      ? 'How likely are you to recommend The Souled Store?'
      : 'This feedback link is invalid or expired. Scan the original receipt again.',
  );
  controls();
}
window.addEventListener('hashchange', consumeFragment);
consumeFragment();
score.addEventListener('change', () => {
  editor.hidden = true;
  controls();
});
load.addEventListener('click', () => {
  void readStatus();
});
check.addEventListener('click', () => {
  void readStatus();
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy || uncertain || done || !capability || editor.hidden) return;
  const optionsResponses: { id: number; rating: number }[] = [];
  for (const select of options.querySelectorAll('select'))
    if (select.value) {
      const id = Number(select.dataset.optionId),
        rating = Number(select.value);
      if (!Number.isSafeInteger(id) || id <= 0 || ![1, 2, 3].includes(rating)) return;
      optionsResponses.push({ id, rating });
    }
  const body = { score: Number(score.value), optionsResponses, additionalFeedback: comment.value };
  busy = true;
  controls();
  void (async () => {
    try {
      const value = await request('POST', body);
      if (
        !record(value) ||
        value.error !== false ||
        value.errorMessage !== null ||
        typeof value.redirectTo !== 'string'
      )
        throw new Error();
      responsePath(value.redirectTo);
      finish('Thank you. Your feedback has been received.');
    } catch {
      uncertain = true;
      notice(
        'The submission result is unconfirmed. Check its status before taking another action. No submission will be repeated automatically.',
      );
    } finally {
      busy = false;
      controls();
    }
  })();
});
controls();
