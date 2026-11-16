import { z } from 'zod';

/** Incoming webhooks are bearer credentials; this validator never contacts their URL. */
export const slackWebhook = z
  .url()
  .max(1000)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'hooks.slack.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)
    );
  }, 'Use a Slack incoming webhook.');
