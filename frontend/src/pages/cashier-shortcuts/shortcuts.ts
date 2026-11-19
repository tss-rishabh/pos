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
/** Verbatim from legacy `order/templates/order/shortcuts.html` ("Keyboard Shortcuts For Billing Screen"). */
export const cashierShortcutDescriptions = [
  ['R', "Press 'R' To Refresh the Cart"],
  ['P', "Press 'P' To Proceed For Payment"],
  ['PP', "Press 'PP' To Proceed For Payment without extra steps(Fast) or Double click"],
  ['F', "Press 'F' For Fast Cash"],
  ['N', "Press 'N' To Enable/Disable NPS Feedback"],
  ['E', "Press 'E' To Enable/Disable Exclusive Benifits"],
  ['B', "Press 'B + Scan' the Product' To Focus/Add Product in Cart"],
  ['S', "Press 'S + Enter' To Select Salesperson From Dropdown"],
  ['T', "Press 'T' To Create New Order"],
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
  // Legacy: B and S focus; F clicks #fast-checkout (create_order.html:1032-1038).
  if (['barcode', 'salesperson'].includes(targetAction)) target.focus();
  else target.click();
  return true;
}
