import { cashierShortcutDescriptions } from './shortcuts';
export function CashierShortcutHelp({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <details className="cashier-shortcut-help">
      <summary>Keyboard shortcuts</summary>
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
    </details>
  );
}
