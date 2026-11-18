import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Page } from '@playwright/test';
import {
  cases,
  type FormCase,
} from '../../../../backend/tools/administration/forms-workflow/cases.js';
import {
  formsFixture,
  type Facts,
} from '../../../../backend/tools/administration/forms-workflow/fixture.js';
import { nativeUiServer } from '../../../../backend/tools/global-reminders/native-ui-server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function inputHashes() {
  const inputs: Record<string, string> = {};
  for (const folder of [
    'backend/src',
    'frontend/src',
    'backend/tools/administration/forms-workflow',
    'frontend/tests/administration/forms-workflow',
  ]) {
    const visit = (directory: string) => {
      for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
        const name = directory + '/' + entry.name;
        if (entry.isDirectory()) {
          if (entry.name !== '__pycache__') visit(name);
        } else if (entry.isFile() && !name.endsWith('.pyc'))
          inputs[name] = createHash('sha256')
            .update(readFileSync(join(root, name)))
            .digest('hex');
      }
    };
    visit(folder);
  }
  return inputs;
}
const inputsBefore = inputHashes();
let sourceInputs: Record<string, string> | undefined;
const web = await nativeUiServer(resolve(root, 'frontend/dist'));
const checks: {
  id: string;
  sourceGet: number;
  sourcePost: number;
  nativeStatus: number;
  sourceFacts: string;
  candidateFacts: string;
  sourceUnchanged: boolean;
  candidateUnchanged: boolean;
  fields: string[];
  exception: string | null;
  physicalDifferences: Record<string, unknown>[];
}[] = [];
let fixture: Awaited<ReturnType<typeof formsFixture>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let stage = 'initialize';
let activeCase: string | null = null;
let diagnostic: Record<string, unknown> = {};
const diagnosticCase = process.env.FORMS_WORKFLOW_DIAGNOSTIC_CASE || null;
const selectedCases = diagnosticCase ? cases.filter((value) => value.id === diagnosticCase) : cases;
assert(!diagnosticCase || selectedCases.length === 1, 'Unknown bounded diagnostic case');

function differences(source: Facts, candidate: Facts) {
  const fields: Record<string, unknown>[] = [];
  const numeric = new Set([
    'id',
    'city_id',
    'state_id',
    'country_id',
    'franchise_id',
    'role',
    'user_type',
    'otp_method',
    'is_active',
    'is_staff',
    'is_superuser',
    'is_mfa',
    'ecom_delivery',
    'ecom_threshold',
  ]);
  for (const table of Object.keys(source) as (keyof Facts)[]) {
    if (source[table].length !== candidate[table].length)
      fields.push({
        table,
        field: 'row-count',
        source: source[table].length,
        candidate: candidate[table].length,
      });
    for (let index = 0; index < Math.min(source[table].length, candidate[table].length); index++) {
      const left = source[table][index]!,
        right = candidate[table][index]!;
      for (const field of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (JSON.stringify(left[field]) === JSON.stringify(right[field])) continue;
        const row: Record<string, unknown> = {
          table,
          index,
          field,
          sourceType: left[field] === null ? 'null' : typeof left[field],
          candidateType: right[field] === null ? 'null' : typeof right[field],
        };
        if (numeric.has(field))
          Object.assign(row, { source: left[field], candidate: right[field] });
        fields.push(row);
      }
    }
  }
  return fields;
}

function comparison(source: Facts, candidate: Facts, input: FormCase) {
  const fields = new Set<string>();
  if (input.cityPreservation || input.nullSlackRetention) {
    const original = source.stores.find((row) => String(row.id) === input.targetId);
    const replacement = candidate.stores.find((row) => String(row.id) === input.targetId);
    assert(original && replacement);
    if (input.cityPreservation) {
      assert.equal(
        Number(original.city_id),
        1111,
        'The source shared edit template resets city_id.',
      );
      assert.equal(
        Number(replacement.city_id),
        7,
        'The instructed edit correction preserves the stored city.',
      );
      fields.add('city_id');
    }
    if (input.nullSlackRetention) {
      assert.equal(
        original.slack_group_url,
        '',
        'The source blank edit changes native NULL to empty.',
      );
      assert.equal(
        replacement.slack_group_url,
        null,
        'The rewrite blank edit preserves native NULL.',
      );
      fields.add('slack_group_url');
    }
    // Assert each declared physical difference first; every other field must match.
    const remaining = (facts: Facts) => ({
      ...facts,
      stores: facts.stores.map((row) =>
        String(row.id) !== input.targetId
          ? row
          : Object.fromEntries(Object.entries(row).filter(([key]) => !fields.has(key))),
      ),
    });
    assert.equal(
      hash(remaining(candidate)),
      hash(remaining(source)),
      'Only explicitly asserted exception fields may differ.',
    );
  } else
    assert.equal(
      hash(candidate),
      hash(source),
      'Source/native persisted scalar/default/mirror values differ in ' + input.id,
    );
}

function apiBody(input: FormCase) {
  const value = input.values;
  if (input.resource === 'operators')
    return {
      firstName: value.firstName,
      lastName: value.lastName,
      email: value.email,
      phone: value.phone,
      contactEmail: value.contactEmail,
      role: Number(value.role),
      otpMethod: Number(value.otpMethod),
      userType: Number(value.userType),
      ...(value.password ? { password: value.password } : {}),
      ...(input.action === 'create' ? { confirmPassword: value.confirmPassword } : {}),
    };
  return {
    name: value.name,
    shortName: value.shortName,
    locationCode: value.locationCode,
    type: value.type,
    category: value.category,
    phone: value.phone,
    email: value.email,
    latitude: value.latitude,
    longitude: value.longitude,
    address: value.address,
    alternateAddress: value.alternateAddress,
    city: value.city,
    state: value.state,
    cityId: Number(value.cityId),
    stateId: Number(value.stateId),
    countryId: Number(value.countryId),
    pincode: value.pincode,
    gstin: value.gstin,
    dailyThreshold: Number(value.dailyThreshold),
    hourlyThreshold: Number(value.hourlyThreshold),
    slackUrl: '',
    removeSlack: false,
    ...(value.category === 'FRANCHISE'
      ? {
          franchise: {
            name: value.franchiseName,
            description: value.franchiseDescription,
            cin: value.franchiseCin,
          },
        }
      : {}),
  };
}
async function field(page: Page, label: string, value: string | undefined, select = false) {
  if (value === undefined) return;
  const input = page.getByRole('dialog').getByLabel(label, { exact: true });
  if (select) await input.selectOption(value);
  else await input.fill(value);
}
async function edit(page: Page, input: FormCase) {
  if (input.resource === 'operators') {
    await page.getByRole('tab', { name: 'Operators', exact: true }).click();
    if (input.action === 'create')
      await page.getByRole('button', { name: 'Create', exact: true }).click();
    else
      await page
        .getByRole('row')
        .filter({ hasText: 'target@example.test' })
        .getByRole('button', { name: 'Edit', exact: true })
        .click();
    await expect(
      page
        .getByRole('dialog')
        .getByLabel('Initial password (at least 12 characters)', { exact: true }),
    ).toHaveCount(input.action === 'create' ? 1 : 0);
    for (const [key, label, select] of [
      ['firstName', 'First name', false],
      ['lastName', 'Last name', false],
      ['email', 'Email', false],
      ['phone', 'Phone', false],
      ['contactEmail', 'OTP email', false],
      ['role', 'Role', true],
      ['otpMethod', 'OTP delivery', true],
      ['userType', 'Ownership', true],
    ] as const)
      await field(page, label, input.values[key], select);
    if (input.action === 'create') {
      await field(page, 'Initial password (at least 12 characters)', input.values.password);
      await field(page, 'Confirm password', input.values.confirmPassword);
    }
  } else {
    if (input.action === 'create')
      await page.getByRole('button', { name: 'Create store', exact: true }).click();
    else
      await page
        .getByRole('row')
        .filter({ hasText: input.targetId === '2' ? 'Franchise Store' : 'Baseline Store' })
        .getByRole('button', { name: 'Edit', exact: true })
        .click();
    await expect(
      page.getByRole('dialog').getByLabel('City reference', { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('dialog')).toContainText(
      'A Slack incoming webhook can be added without exposing it in store reads.',
    );
    await field(page, 'Ownership', input.values.category, true);
    if (input.values.category === 'FRANCHISE') {
      await field(page, 'Franchise association', 'details', true);
      await field(page, 'Franchise name', input.values.franchiseName);
      await field(page, 'Franchise description', input.values.franchiseDescription);
      await field(page, 'Franchise CIN', input.values.franchiseCin);
    }
    for (const [key, label, select] of [
      ['name', 'Store name', false],
      ['shortName', 'Short name', false],
      ['locationCode', 'Location code', true],
      ['type', 'Store type', true],
      ['phone', 'Store phone', false],
      ['email', 'Store email', false],
      ['address', 'Address', false],
      ['alternateAddress', 'Alternate address', false],
      ['gstin', 'GSTIN', false],
      ['dailyThreshold', 'Daily order capacity', false],
      ['hourlyThreshold', 'Hourly order capacity', false],
    ] as const)
      await field(page, label, input.values[key], select);
    if (input.postal) {
      await field(page, 'PIN code', '999999');
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Look up PIN code', exact: true })
        .click();
      await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
        'No location was found',
      );
      await field(page, 'PIN code', '400001');
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Look up PIN code', exact: true })
        .click();
      await expect(page.getByRole('dialog').getByLabel('City', { exact: true })).toHaveValue(
        'Mumbai',
      );
      await expect(page.getByRole('dialog').getByLabel('Country', { exact: true })).toHaveValue(
        '99',
      );
      await expect(page.getByRole('dialog').getByLabel('Latitude', { exact: true })).toHaveValue(
        '19.0000000000000001',
      );
      await expect(page.getByRole('dialog').getByLabel('Address', { exact: true })).toHaveValue(
        input.values.address!,
      );
    } else
      for (const [key, label, select] of [
        ['latitude', 'Latitude', false],
        ['longitude', 'Longitude', false],
        ['city', 'City', false],
        ['state', 'State', false],
        ['stateId', 'State reference', false],
        ['countryId', 'Country', true],
        ['pincode', 'PIN code', false],
      ] as const)
        await field(page, label, input.values[key], select);
  }
}

try {
  const database = process.env.FORMS_WORKFLOW_MYSQL_URL;
  const python = process.env.FORMS_WORKFLOW_PYTHON;
  assert(database && python);
  fixture = await formsFixture(database, web.origin, process.argv[2] || '', python);
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(chrome) ? chrome : undefined),
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  for (const input of selectedCases) {
    activeCase = input.id;
    stage = 'source-dispatch';
    const source = await fixture.original(input);
    if (sourceInputs) assert.deepEqual(source.observed.hashes, sourceInputs);
    else sourceInputs = source.observed.hashes;
    diagnostic = {
      sourceGet: source.observed.getStatus,
      sourcePost: source.observed.postStatus,
      validationFields: source.observed.validationFields,
      formDefaults: source.observed.formDefaults,
    };
    stage = 'candidate-reset';
    await fixture.reset(input);
    const before = await fixture.fingerprint();
    const account = await fixture.account(input.actorId);
    const priorTargetSession: { valid(): Promise<boolean> } | undefined =
      input.resource === 'operators' && input.action === 'update'
        ? await fixture.account(input.targetId!)
        : undefined;
    stage = 'candidate-application';
    web.attach(await fixture.application());
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addCookies([account.cookie]);
    const page = await context.newPage();
    let status: number;
    try {
      stage = 'routed-ui';
      await page.goto(web.origin + '/administration');
      if (
        input.actorId === '4' ||
        input.actorId === '5' ||
        (input.resource === 'stores' && input.actorId === '2') ||
        input.expected === 'password-restriction'
      ) {
        const response = await context.request.fetch(
          web.origin +
            '/api/v1/admin/' +
            input.resource +
            (input.action === 'update' ? '/' + input.targetId : ''),
          {
            method: input.action === 'create' ? 'POST' : 'PUT',
            headers: { Origin: web.origin, 'X-Operator-Id': input.actorId },
            data: apiBody(input),
          },
        );
        status = response.status();
        assert.equal(
          status,
          input.expected === 'password-restriction' ? 400 : 403,
          'Current API must retain its documented restriction.',
        );
        if (input.expected === 'password-restriction') {
          await page.getByRole('tab', { name: 'Operators', exact: true }).click();
          await page
            .getByRole('row')
            .filter({ hasText: 'target@example.test' })
            .getByRole('button', { name: 'Edit', exact: true })
            .click();
          await expect(
            page.getByRole('dialog').getByLabel('Confirm password', { exact: true }),
          ).toHaveCount(0);
        }
      } else {
        await edit(page, input);
        const path =
          '/api/v1/admin/' +
          input.resource +
          (input.action === 'update' ? '/' + input.targetId : '');
        const response = page.waitForResponse(
          (value) =>
            new URL(value.url()).pathname === path &&
            value.request().method() === (input.action === 'create' ? 'POST' : 'PUT'),
        );
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Save changes', exact: true })
          .click();
        status = (await response).status();
        if (input.expected === 'save') {
          assert.equal(
            status,
            input.action === 'create' ? 201 : 200,
            'Actual App must persist an authorized form.',
          );
          await expect(page.getByRole('dialog')).toHaveCount(0);
        } else {
          assert([400, 409].includes(status), 'Invalid/duplicate form must be refused.');
          await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
        }
      }
      stage = 'native-persistence-comparison';
      const after = await fixture.fingerprint();
      const candidate = await fixture.facts();
      diagnostic = {
        ...diagnostic,
        nativeStatus: status,
        differences: differences(source.facts, candidate),
      };
      if (input.expected === 'password-restriction') {
        assert.equal(source.observed.postStatus, 302);
        assert.equal(source.observed.sourcePasswordValid, true);
        assert.equal(after, before, 'Restricted ordinary password edit must not mutate records.');
      } else {
        comparison(source.facts, candidate, input);
        if (input.expected === 'reject') {
          assert.equal(source.before, source.after, 'Rejected original form must retain records.');
          assert.equal(before, after, 'Rejected rewrite form must retain records.');
        } else {
          assert.equal(
            source.observed.postStatus,
            302,
            'Pinned source must accept the valid form.',
          );
          if (input.resource === 'operators' && input.action === 'create') {
            assert.equal(source.observed.sourcePasswordValid, true);
            assert.equal(await fixture.passwordValid(input.values.email!), true);
          }
        }
      }
      if (priorTargetSession)
        assert.equal(
          await priorTargetSession.valid(),
          !input.credentialsChanged,
          'Current credentials must be revoked exactly for material changes.',
        );
      if (input.id === 'operator-create-admin-source-empty-role-picker')
        assert.deepEqual(source.observed.controls.selects['userform-role'], []);
      if (input.resource === 'stores' && source.observed.getStatus === 200)
        assert.equal(source.observed.controls.hiddenCity, '1111');
      checks.push({
        id: input.id,
        sourceGet: source.observed.getStatus,
        sourcePost: source.observed.postStatus,
        nativeStatus: status,
        sourceFacts: hash(source.facts),
        candidateFacts: hash(candidate),
        physicalDifferences: differences(source.facts, candidate),
        sourceUnchanged: source.before === source.after,
        candidateUnchanged: before === after,
        fields: source.observed.controls.inputNames,
        exception: input.nullSlackRetention
          ? 'documented-blank-edit-preserves-null-secret-state'
          : input.cityPreservation
            ? 'instructed-stored-city-preservation'
            : input.expected === 'password-restriction'
              ? 'documented-current-superuser-password-flow'
              : input.id.includes('source-empty-role')
                ? 'source-role-two-empty-control-observation'
                : null,
      });
      process.stdout.write(
        JSON.stringify({
          module: 'parity',
          resource: 'administration-forms-workflow',
          eventId: 'parity.administration-forms-workflow.case.completed',
          eventInstanceId: randomUUID(),
          requestId: null,
          userId: null,
          caseId: input.id,
          sourceStatus: source.observed.postStatus,
          nativeStatus: status,
        }) + '\n',
      );
    } finally {
      await context.close();
    }
  }
  stage = 'receipt';
  activeCase = null;
  const inputs = inputHashes();
  assert.deepEqual(
    inputs,
    inputsBefore,
    'Production and owned harness inputs changed during execution.',
  );
  const receipt = {
    scope:
      'Four custom source create/update forms with native persistence and routed App; global layout/provider acceptance excluded',
    sourceCommit: '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a',
    diagnosticOnly: diagnosticCase !== null,
    sourceInputs,
    inputsUnchanged: true,
    cases: checks,
    passed: checks.length,
    inputs,
    boundaries: [
      'Original selected forms/models/view bodies and native source sessions/CSRF, with unrelated base chrome omitted.',
      'Real buildApp and native-cookie requests; real routed UI; no response fulfillment or candidate principal injection.',
      'Generated password salts/strength differ intentionally; each actual stored password is independently verified.',
      'Volatile creation/update/login/joined timestamps are excluded from persisted scalar comparisons; no timestamp-parity claim.',
      'Accepted city/password restrictions and source role2 empty controls are explicit; no provider/OTP transport is configured.',
    ],
    releaseLedgerPromoted: false,
  };
  const output = process.env.FORMS_WORKFLOW_RECEIPT;
  assert(output);
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      module: 'parity',
      resource: 'administration-forms-workflow',
      eventId: 'parity.administration-forms-workflow.completed',
      eventInstanceId: randomUUID(),
      requestId: null,
      userId: null,
      passed: checks.length,
      releaseLedgerPromoted: false,
    }) + '\n',
  );
} catch (error: unknown) {
  const kind = error instanceof Error ? error.name : typeof error;
  const sourceDiagnostic =
    error instanceof Error && error.message.startsWith('SOURCE_CASE_FAILED:')
      ? error.message
      : undefined;
  process.stderr.write(
    JSON.stringify({
      module: 'parity',
      resource: 'administration-forms-workflow',
      eventId: 'parity.administration-forms-workflow.failed',
      eventInstanceId: randomUUID(),
      requestId: null,
      userId: null,
      stage,
      caseId: activeCase,
      kind,
      sourceDiagnostic,
      diagnostic,
      completedCases: checks.map((value) => value.id),
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  await fixture?.close();
  await web.close();
}
