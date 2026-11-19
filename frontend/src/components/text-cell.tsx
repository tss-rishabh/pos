/**
 * A table cell for plain text (W27): one line, truncated with an ellipsis at a shared width, with
 * the full value in the tooltip. Empty values render as an em dash.
 */
export function TextCell({ value }: { value: unknown }) {
  const text = value === null || value === undefined || value === '' ? '—' : String(value);
  return (
    <td className="text-cell" title={text === '—' ? undefined : text}>
      {text}
    </td>
  );
}
