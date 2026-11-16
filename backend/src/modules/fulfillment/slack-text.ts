/** Slack interprets angle-bracket mentions/links. Escape all data interpolated into mrkdwn. */
export function slackText(value: string | null | undefined) {
  return (value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
