/**
 * Reads a colour theme token (defined on :root in styles.css) for places CSS variables cannot reach,
 * such as a sandboxed iframe document. Only plain hex values are passed through, so a token can never
 * inject CSS; anything else falls back to the system text colour.
 */
export function themeColour(token: `--${string}`): string {
  const value =
    typeof document === 'undefined'
      ? ''
      : getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value : 'CanvasText';
}
