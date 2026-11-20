import { it, expect } from 'vitest';
import {
  evaluateRelease,
  releaseRequirementIds,
  releaseCoverageSchema,
  sourceInventorySchema,
} from '../src/domain/release.js';

const commit = 'a'.repeat(40);
const inventory = sourceInventorySchema.parse({
  source_commit: commit,
  routes: [{ id: 'route' }],
  websockets: [{ id: 'socket' }],
  jobs: [{ id: 'job' }],
  templates: [{ id: 'template' }],
  administration: [{ id: 'admin' }],
});
const verified = {
  status: 'verified',
  implementation: ['backend/src/app.ts'],
  tests: ['backend/tests/parity.test.ts'],
  evidence: ['backend/evidence/fixture.json'],
};
const coverage = () =>
  releaseCoverageSchema.parse({
    version: 1,
    sourceCommit: commit,
    surfaces: [
      ['route', 'route'],
      ['websocket', 'socket'],
      ['job', 'job'],
      ['template', 'template'],
      ['administration', 'admin'],
    ].map(([kind, id]) => ({ ...verified, kind, id })),
    requirements: releaseRequirementIds.map((id) => ({ ...verified, id })),
  });
it('requires jobs, templates and hidden administration surfaces alongside HTTP routes', () => {
  const one = coverage();
  one.surfaces = one.surfaces.filter((value) => value.kind === 'route');
  const result = evaluateRelease(
    inventory,
    one,
    () => true,
    () => true,
  );
  expect(result.productionReady).toBe(false);
  expect(result.pendingSurfaces).toBe(4);
});
it('rejects stale or missing evidence, unknown surfaces and duplicate certification', () => {
  const one = coverage();
  one.sourceCommit = 'b'.repeat(40);
  one.surfaces.push(one.surfaces[0]!);
  const result = evaluateRelease(
    inventory,
    one,
    () => false,
    () => true,
  );
  expect(result.productionReady).toBe(false);
  expect(result.failures).toHaveLength(2);
  expect(result.pendingRequirements).toHaveLength(releaseRequirementIds.length);
});
it('permits release only with valid evidence for every surface and requirement', () => {
  expect(
    evaluateRelease(
      inventory,
      coverage(),
      () => true,
      () => true,
    ).productionReady,
  ).toBe(true);
  expect(
    evaluateRelease(
      inventory,
      coverage(),
      () => true,
      () => false,
    ).productionReady,
  ).toBe(false);
});
it('reports user-removed surfaces separately and only with a recorded AGENTS.md decision', () => {
  const one = coverage();
  one.surfaces = one.surfaces.map((entry) =>
    entry.kind === 'template'
      ? releaseCoverageSchema.shape.surfaces.element.parse({
          kind: 'template',
          id: 'template',
          status: 'removed',
          decision: 'AGENTS.md: UI cleanup, 20 November 2026 (user)',
        })
      : entry,
  );
  const result = evaluateRelease(
    inventory,
    one,
    () => true,
    () => true,
  );
  expect(result.surfaces['template']).toEqual({ total: 1, verified: 0, removed: 1, pending: 0 });
  expect(result.pendingSurfaces).toBe(0);
  expect(result.productionReady).toBe(true);
  expect(() =>
    releaseCoverageSchema.shape.surfaces.element.parse({
      kind: 'template',
      id: 'template',
      status: 'removed',
    }),
  ).toThrow();
  expect(() =>
    releaseCoverageSchema.shape.surfaces.element.parse({
      kind: 'template',
      id: 'template',
      status: 'removed',
      decision: 'because',
    }),
  ).toThrow();
});
