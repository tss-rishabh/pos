import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { request } from '../../api/client';

export const accessCapabilitiesSchema = z.object({
  reconciled: z.boolean(),
  canManage: z.boolean(),
  staff: z.boolean(),
  superuser: z.boolean(),
  internal: z.boolean(),
  canViewGroups: z.boolean(),
  canViewOperators: z.boolean(),
});
export const accessPermissionSchema = z.object({
  key: z.string(),
  appLabel: z.string(),
  model: z.string(),
  codename: z.string(),
  name: z.string(),
});
export const accessGroupSummary = z.object({ id: z.uuid(), name: z.string() });
export const accessGroupSchema = accessGroupSummary.extend({
  version: z.string().regex(/^[a-f0-9]{64}$/),
  permissionKeys: z.array(z.string()),
  memberCount: z.string().regex(/^\d+$/),
});
export const operatorAccessSchema = z.object({
  id: z.string(),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  isStaff: z.boolean(),
  isSuperuser: z.boolean(),
  groupIds: z.array(z.uuid()),
  groups: z.array(accessGroupSummary),
  permissionKeys: z.array(z.string()),
});
export const accessSuccessSchema = z.object({
  id: z.string(),
  status: z.literal('success'),
  message: z.string(),
  reauthenticate: z.boolean().optional(),
});
export const groupDeletionPreviewSchema = z.object({
  groups: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        version: z.string().regex(/^[a-f0-9]{64}$/),
        memberCount: z.string().regex(/^\d+$/),
        permissionCount: z.number().int().min(0).max(5000),
      }),
    )
    .min(1)
    .max(100),
  membershipCount: z.number().int().min(0).max(100000),
  permissionAssignmentCount: z.number().int().min(0).max(20000),
  operatorAccountsDeleted: z.literal(0),
});
export const useAccessCapabilities = (ownerId: string) =>
  useQuery({
    queryKey: [ownerId, 'administration', 'model-access-capabilities'],
    queryFn: ({ signal }) =>
      request(
        '/api/v1/admin/access/capabilities',
        { cache: 'no-store', signal, operatorId: ownerId },
        accessCapabilitiesSchema,
      ),
    retry: false,
  });
export function useAccessCollection<T>(
  ownerId: string,
  path: string,
  schema: z.ZodType<T>,
  search: string,
  enabled: boolean,
) {
  const [settled, setSettled] = useState(search);
  useEffect(() => {
    const timeout = setTimeout(() => setSettled(search), 200);
    return () => clearTimeout(timeout);
  }, [search]);
  return useInfiniteQuery({
    queryKey: [ownerId, 'administration', path, settled],
    enabled,
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      request(
        `${path}/search`,
        {
          method: 'POST',
          operatorId: ownerId,
          cache: 'no-store',
          signal,
          body: JSON.stringify({ after: pageParam, limit: 50, search: settled }),
        },
        z.object({ data: z.array(schema), nextCursor: z.string().nullable() }),
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
export const toggleAccessSelection = (values: string[], key: string, checked: boolean) =>
  checked ? [...new Set([...values, key])] : values.filter((value) => value !== key);
