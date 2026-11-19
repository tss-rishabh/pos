import { z } from 'zod';

const item = z.object({ id: z.string().min(1), include: z.string().nullable().optional() });
export const sourceInventorySchema = z.object({
  source_commit: z.string().regex(/^[a-f0-9]{40}$/),
  routes: z.array(item),
  websockets: z.array(item),
  jobs: z.array(item),
  templates: z.array(item),
  administration: z.array(item),
});
const verification = z.object({
  status: z.enum(['pending', 'blocked', 'verified']),
  implementation: z.array(z.string().min(1)),
  tests: z.array(z.string().min(1)),
  evidence: z.array(z.string().min(1)),
  notes: z.string().optional(),
});
export const releaseCoverageSchema = z
  .object({
    version: z.literal(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    surfaces: z.array(
      verification.extend({
        kind: z.enum(['route', 'websocket', 'job', 'template', 'administration']),
        id: z.string().min(1),
      }),
    ),
    requirements: z.array(verification.extend({ id: z.string().min(1) })),
  })
  .strict();
export const releaseRequirementIds = [
  'full-behavior-parity',
  'legacy-authentication',
  'warehouse-parity-and-freshness',
  'financial-provider-contracts',
  'inventory-writer-procedure',
  'performance-benchmarks',
  'security-review',
  'offline-web-and-desktop',
  'desktop-signing',
  'desktop-windows-macos',
  'deployment-and-rollback',
  'background-workers',
] as const;
type Inventory = z.infer<typeof sourceInventorySchema>;
type Coverage = z.infer<typeof releaseCoverageSchema>;
export function evaluateRelease(
  inventory: Inventory,
  coverage: Coverage,
  validateEvidence: (path: string, references: string[]) => boolean,
  validateCode: (path: string) => boolean,
) {
  const failures: string[] = [];
  if (coverage.sourceCommit !== inventory.source_commit)
    failures.push('Coverage does not match the inventoried source commit.');
  const entries = new Map<string, Coverage['surfaces'][number]>();
  for (const entry of coverage.surfaces) {
    const key = `${entry.kind}:${entry.id}`;
    if (entries.has(key)) failures.push(`Duplicate surface certificate: ${key}`);
    entries.set(key, entry);
  }
  const categories = {
    route: inventory.routes.filter((route) => !route.include),
    websocket: inventory.websockets,
    job: inventory.jobs,
    template: inventory.templates,
    administration: inventory.administration,
  };
  const valid = (entry: z.infer<typeof verification> | undefined) =>
    Boolean(
      entry?.status === 'verified' &&
      entry.implementation.length &&
      entry.tests.length &&
      entry.evidence.length &&
      entry.implementation.every(validateCode) &&
      entry.tests.every(validateCode) &&
      entry.evidence.every((path) =>
        validateEvidence(path, [...entry.implementation, ...entry.tests]),
      ),
    );
  const surfaces = Object.fromEntries(
    Object.entries(categories).map(([kind, items]) => {
      const verified = items.filter((surface) =>
        valid(entries.get(`${kind}:${surface.id}`)),
      ).length;
      return [kind, { total: items.length, verified, pending: items.length - verified }];
    }),
  );
  const validKeys = new Set(
    Object.entries(categories).flatMap(([kind, items]) =>
      items.map((surface) => `${kind}:${surface.id}`),
    ),
  );
  for (const key of entries.keys())
    if (!validKeys.has(key))
      failures.push(`Certificate refers to an unknown source surface: ${key}`);
  const requirements = new Map<string, Coverage['requirements'][number]>();
  for (const entry of coverage.requirements) {
    if (requirements.has(entry.id)) failures.push(`Duplicate release requirement: ${entry.id}`);
    requirements.set(entry.id, entry);
  }
  const pendingRequirements = releaseRequirementIds.filter((id) => !valid(requirements.get(id)));
  const pendingSurfaces = Object.values(surfaces).reduce((sum, value) => sum + value.pending, 0);
  return {
    sourceCommit: inventory.source_commit,
    surfaces,
    pendingSurfaces,
    pendingRequirements,
    failures,
    productionReady:
      pendingSurfaces === 0 && pendingRequirements.length === 0 && failures.length === 0,
  };
}
