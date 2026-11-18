import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { checkInSchema } from '../pages/administration/api';

const responseSchema = z.object({ data: checkInSchema.nullable() });
const serverGeneration = () => 0;

/** A successful server read is new authority even when its record/time is unchanged. */
export function useCheckInAuthorityGeneration(operatorId: string): number {
  const client = useQueryClient();
  const observed = useRef({ client, operatorId, generation: 0 });
  if (observed.current.client !== client || observed.current.operatorId !== operatorId)
    observed.current = { client, operatorId, generation: 0 };
  const snapshot = useCallback(() => observed.current.generation, []);
  const subscribe = useCallback(
    (notify: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (
          observed.current.client !== client ||
          observed.current.operatorId !== operatorId ||
          event.type !== 'updated' ||
          event.action.type !== 'success' ||
          event.action.manual
        )
          return;
        const key = event.query.queryKey;
        if (
          key.length !== 3 ||
          key[0] !== operatorId ||
          key[1] !== 'administration' ||
          key[2] !== 'my-check-in' ||
          !responseSchema.safeParse(event.action.data).success
        )
          return;
        observed.current.generation++;
        notify();
      }),
    [client, operatorId],
  );
  return useSyncExternalStore(subscribe, snapshot, serverGeneration);
}
