export type CashierShortcut =
  | 'refresh'
  | 'proceed'
  | 'fast-proceed'
  | 'fast-cash'
  | 'toggle-nps'
  | 'toggle-exclusive'
  | 'barcode'
  | 'salesperson'
  | 'new-sale';
export interface CashierShortcutRequest {
  id: string;
  action: CashierShortcut;
  requestedAt: number;
}
export const cashierShortcutDescriptions = [
  ['R', 'Refresh the sale'],
  ['P / PP', 'Proceed through the current validated payment step'],
  ['F', 'Open fast cash and focus cash received'],
  ['N', 'Toggle the shopping feedback link'],
  ['E', 'Toggle walk-in member benefits'],
  ['B', 'Focus barcode search'],
  ['S', 'Select the sale salesperson'],
  ['T', 'Start another sale'],
] as const;
const keys: Readonly<Record<string, CashierShortcut>> = {
  r: 'refresh',
  p: 'proceed',
  f: 'fast-cash',
  n: 'toggle-nps',
  e: 'toggle-exclusive',
  b: 'barcode',
  s: 'salesperson',
  t: 'new-sale',
};
export function cashierShortcutKey(
  event: Pick<
    KeyboardEvent,
    'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'isComposing' | 'repeat' | 'defaultPrevented'
  >,
): CashierShortcut | null {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return null;
  const key = event.key.toLowerCase();
  return Object.hasOwn(keys, key) ? (keys[key] ?? null) : null;
}
function typing(element: EventTarget): boolean {
  return (
    element instanceof Element &&
    Boolean(
      element.closest(
        'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="searchbox"]',
      ),
    )
  );
}
export function cashierShortcutScope(root: HTMLElement): HTMLElement | null {
  const dialogs = [
    ...root.ownerDocument.querySelectorAll<HTMLElement>(
      '[role="dialog"][aria-modal="true"],dialog[open]',
    ),
  ].filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
  const dialog = dialogs.at(-1);
  if (!dialog) return root;
  return root.contains(dialog) && dialog.dataset.cashierShortcuts === 'review' ? dialog : null;
}
export function bindCashierShortcuts(
  root: HTMLElement,
  onAction: (action: CashierShortcut) => boolean,
) {
  let lastProceed = -Infinity;
  const handler = (event: KeyboardEvent) => {
    let action = cashierShortcutKey(event);
    if (
      !action ||
      event.composedPath().some(typing) ||
      !root.isConnected ||
      !cashierShortcutScope(root)
    ) {
      lastProceed = -Infinity;
      return;
    }
    if (action === 'proceed') {
      const now = performance.now();
      if (now - lastProceed < 500) action = 'fast-proceed';
      lastProceed = now;
    } else lastProceed = -Infinity;
    if (onAction(action)) event.preventDefault();
  };
  root.ownerDocument.addEventListener('keydown', handler);
  return () => root.ownerDocument.removeEventListener('keydown', handler);
}
function reveal(element: HTMLElement, root: HTMLElement) {
  for (
    let parent = element.parentElement;
    parent && root.contains(parent);
    parent = parent.parentElement
  )
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  element.scrollIntoView({ block: 'nearest' });
}
/** Targets existing controls; no shortcut is registered for charging or completing cash. */
export function invokeCashierShortcut(
  root: HTMLElement,
  action: CashierShortcut | 'quote',
): boolean {
  const targetAction = action === 'fast-proceed' ? 'proceed' : action;
  const target = root.querySelector<HTMLElement>(`[data-cashier-action~="${targetAction}"]`);
  if (!target || target.matches(':disabled,[aria-disabled="true"]') || target.closest('[inert]'))
    return false;
  reveal(target, root);
  if (['barcode', 'salesperson', 'fast-cash'].includes(targetAction)) target.focus();
  else target.click();
  return true;
}
