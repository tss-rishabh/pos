import { createContext, useContext } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export const AdministrationAuthenticationContext = createContext<(() => Promise<void>) | null>(
  null,
);
export function useAdministrationAuthenticationChange() {
  const clear = useContext(AdministrationAuthenticationContext),
    client = useQueryClient();
  return async () => {
    if (clear) await clear();
    else await client.invalidateQueries({ queryKey: ['operator'] });
  };
}
