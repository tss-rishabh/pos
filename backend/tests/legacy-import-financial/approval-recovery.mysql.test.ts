import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyOrderImportFinancialApprovals } from '../../src/modules/legacy-order-imports/financial-adapter-approval.js';
import { financialClock, financialPlan, importFinancialFixture } from './fixture.js';
import { legacyOrderImportRepository } from '../../src/modules/legacy-order-imports/repository.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
import { runtimeImportInput } from '../legacy-order-imports/runtime-fixture.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('exact native approval-command recovery', () => {
  let fixture: Awaited<ReturnType<typeof importFinancialFixture>>;
  beforeAll(async () => {
    fixture = await importFinancialFixture(template!);
    await fixture.reset();
  });
  afterAll(async () => fixture?.close());
  it('reads the original command rather than a newer grant and never extends the original expiry', async () => {
    let clock = financialClock;
    const plan = { ...financialPlan(), createdAt: '2026-06-14 12:00:00' },
      input = fixture.input(plan),
      scope = {
        actorId: input.actorId,
        operationId: input.operationId,
        storeId: input.storeId,
        counterId: input.counterId,
      },
      approvals = legacyOrderImportFinancialApprovals(fixture.config, fixture.db, {
        secret: fixture.options.secret,
        clock: () => clock,
      }),
      firstRequest = {
        approverId: '1',
        scope,
        plan,
        planHash: input.planHash,
        commandId: randomUUID(),
        reason: 'historical-correction' as const,
      },
      first = await approvals.request(firstRequest);
    clock += 1000;
    const secondRequest = { ...firstRequest, commandId: randomUUID() },
      second = await approvals.request(secondRequest);
    expect((await approvals.read(scope, input.planHash))?.id).toBe(second.id);
    expect(await approvals.read(scope, input.planHash, firstRequest.commandId)).toEqual(first);
    expect(await approvals.request(firstRequest)).toEqual(first);
    expect(first.expiresAt).toBe(financialClock + 3600000);
    expect(await approvals.read(scope, input.planHash, randomUUID())).toBeNull();
    expect(
      await approvals.read(
        { ...scope, operationId: randomUUID() },
        input.planHash,
        firstRequest.commandId,
      ),
    ).toBeNull();
  });
  it('runs the real financial adapter through the coordinator and retains the initiating request in later worker logs', async () => {
    await fixture.reset();
    const repository = legacyOrderImportRepository(fixture.db, { secret: fixture.options.secret }),
      input = runtimeImportInput(),
      requests: string[] = [],
      adapter = legacyOrderImportFinancialAdapter(
        fixture.config,
        fixture.db,
        {
          ...fixture.options,
          observe: (event) => requests.push(event.requestId),
        },
        fixture.transport(),
      );
    input.csv = input.csv.replace('25.49', '25.00');
    await repository.stage('1', 'initiating-import-request', input);
    const outcome = await repository.runOne(adapter);
    expect(outcome).toMatchObject({ jobId: input.id, state: 'IMPORTED', actorId: '1' });
    expect(await repository.detail('1', input.id)).toMatchObject({
      state: 'COMPLETED',
      importedOrders: 1,
    });
    expect(requests).toEqual(['initiating-import-request']);
  });
});
