import { createFeedbackApp } from './pos_feedback_factory.ts';
import feedbackLogger from './src/utils/PosFeedbackPrivacy.ts';

// Do not use the original --import instrumentation.ts start command for this process.
if (
  process.env.NODE_OPTIONS ||
  process.execArgv.some((value) => /^(--import|--require|-r)(=|$)/.test(value))
)
  throw new Error(
    'Private feedback requires an isolated process without instrumentation preloads.',
  );
const portValue = process.env.POS_FEEDBACK_PORT ?? '';
if (!/^[0-9]{2,5}$/.test(portValue) || Number(portValue) > 65535)
  throw new Error('Private feedback port is not configured.');
const app = await createFeedbackApp();
try {
  await app.listen({ port: Number(portValue), host: '0.0.0.0' });
} catch {
  feedbackLogger.error();
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
