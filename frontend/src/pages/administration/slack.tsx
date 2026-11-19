import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

/** Legacy `SLACK_CONNECT_BROADCAST_CHANNEL` (`helpers/slack_helpers.py:14`). */
const broadcastChannel = 'tss-slack-connect';
const result = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  url: z.string().nullable(),
  channel: z.string().nullable(),
  nonce: z.string().nullable(),
});

/**
 * Legacy "Connect/Reconnect Slack channel" (`stores/templates/stores/_form.html:312-345`): opens
 * the connect popup, receives the webhook over BroadcastChannel and fills the field. The operator
 * must still save the form.
 */
export function SlackConnectButton({
  connected,
  onConnected,
  disabled = false,
}: {
  connected: boolean;
  onConnected: (url: string) => void;
  disabled?: boolean;
}) {
  const nonce = useRef<string | null>(null),
    [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const latest = useRef(onConnected);
  latest.current = onConnected;
  useEffect(() => {
    if (!('BroadcastChannel' in window)) return;
    const channel = new BroadcastChannel(broadcastChannel);
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      const parsed = result.safeParse(event.data);
      if (!parsed.success || !nonce.current || parsed.data.nonce !== nonce.current) return;
      nonce.current = null;
      if (parsed.data.ok && parsed.data.url) {
        latest.current(parsed.data.url);
        setStatus({
          ok: true,
          text: `Connected to ${parsed.data.channel || 'the selected channel'}. Click Save to apply.`,
        });
      } else setStatus({ ok: false, text: parsed.data.error || 'Slack connect failed.' });
    });
    return () => channel.close();
  }, []);
  return (
    <>
      <button
        type="button"
        className="button secondary"
        disabled={disabled}
        onClick={() => {
          const value = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
            byte.toString(36).padStart(2, '0'),
          ).join('');
          nonce.current = value;
          const popup = window.open(
            `/api/v1/admin/slack/connect?nonce=${value}`,
            'slack-connect',
            'width=640,height=760',
          );
          if (!popup)
            setStatus({
              ok: false,
              text: 'Popup blocked. Allow popups for this site and try again.',
            });
        }}
      >
        {connected ? 'Reconnect Slack channel' : 'Connect Slack channel'}
      </button>
      {status && (
        <small role="status" className={status.ok ? 'administration-success' : 'inline-error'}>
          {status.text}
        </small>
      )}
    </>
  );
}
