import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { request } from '../api/client';
import type { Principal } from '../api/types';

const quoteSchema = z.object({ text: z.string().min(1).max(2000) }).strict();

export function MotivationalQuote({
  user,
  online,
  rotate = false,
}: {
  user: Principal;
  online: boolean;
  rotate?: boolean;
}) {
  const quote = useQuery({
    queryKey: [user.id, 'motivational-quote'],
    queryFn: ({ signal }) =>
      request('/api/v1/motivational-quotes/random', { signal, operatorId: user.id }, quoteSchema),
    enabled: online,
    staleTime: 6000,
    retry: false,
    refetchInterval: rotate && online ? 7000 : false,
    refetchIntervalInBackground: false,
  });
  return (
    <aside aria-label="Customer service thought" className="callout">
      <div className="inline-actions">
        <span className="caption">A thought for your shift</span>
        <button
          className="button secondary small"
          disabled={!online || quote.isFetching}
          onClick={() => void quote.refetch()}
        >
          Refresh thought
        </button>
      </div>
      <p>
        {quote.data?.text ??
          (quote.isFetching
            ? 'Loading a thought…'
            : online
              ? 'Thoughts are temporarily unavailable.'
              : 'Reconnect to load a thought.')}
      </p>
    </aside>
  );
}
