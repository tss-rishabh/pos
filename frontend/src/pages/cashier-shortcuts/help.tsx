import { cashierShortcutDescriptions } from './shortcuts';
export function CashierShortcutReferenceContent({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onChange(event.target.checked)}
        />{' '}
        Enable letter shortcuts
      </label>
      <table>
        <tbody>
          {cashierShortcutDescriptions.map(([key, description]) => (
            <tr key={key}>
              <th>
                <kbd>{key}</kbd>
              </th>
              <td>{description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="caption">
        Shortcuts pause while you type or use another dialog. Payment still requires its existing
        checks and confirmation.
      </p>
    </>
  );
}

export function CashierShortcutHelp(props: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <details className="cashier-shortcut-help">
      <summary>Keyboard shortcuts</summary>
      <CashierShortcutReferenceContent {...props} />
    </details>
  );
}
