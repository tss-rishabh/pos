import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';
import { z } from 'zod';
import type { Principal, Store } from '../api/types';
import { request } from '../api/client';
import { checkInSchema } from '../pages/administration/api';
import { ReleaseNotes } from './release-notes';
import './workspace-context.css';

/** Workspace selection does not establish a server check-in. */
export function WorkspaceContext({
  user,
  stores,
  online,
  native,
}: {
  user: Principal;
  stores: readonly Store[];
  online: boolean;
  native: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  const current = useQuery({
    queryKey: [user.id, 'administration', 'my-check-in'],
    enabled: native && online,
    queryFn: ({ signal }) =>
      request(
        '/api/v1/operators/me/check-in',
        { operatorId: user.id, signal },
        z.object({ data: checkInSchema.nullable() }),
      ),
    staleTime: 10000,
    retry: false,
  });
  const checkIn = current.data?.data;
  const expiresAt = checkIn ? Date.parse(checkIn.expiresAt) : NaN;
  useEffect(() => {
    if (!Number.isFinite(expiresAt)) return;
    const update = () => setNow(Date.now());
    const timer = window.setTimeout(
      update,
      Math.max(0, Math.min(2147483647, expiresAt - Date.now() + 1)),
    );
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [expiresAt]);
  let status = 'Not checked in';
  if (!online) status = 'Check-in unverified offline';
  else if (current.isPending) status = 'Checking server check-in…';
  else if (current.isError) status = 'Check-in unavailable';
  else if (checkIn && expiresAt > Math.max(now, Date.now())) {
    const store = stores.find((item) => item.id === checkIn.storeId);
    status = `Checked in at ${store?.name || `store ${checkIn.storeId}`}`;
  }
  return (
    <div className="workspace-context" aria-label="Operator context">
      {native && (
        <NavLink to="/check-in" aria-label={`Server check-in: ${status}`}>
          {status}
        </NavLink>
      )}
      <ReleaseNotes role={user.role} />
      <span className="account-type" aria-label="Account type">
        {user.userType === 2 ? 'Franchise' : 'In-House'}
      </span>
    </div>
  );
}
