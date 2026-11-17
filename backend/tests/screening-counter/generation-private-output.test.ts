import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { generationEnvironment } from './generation-fixture.js';
const entry = 'src/modules/legacy-order-imports/screening-counter/counter-generation-main.ts';
function run(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['--import', 'tsx', entry], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    timeout: 10000,
  });
}
describe('quota worker command privacy and disabled startup', () => {
  it('absent selector exits disabled without requiring credentials, native URL or an enabled application', () => {
    const result = run({
      DEMO_MODE: 'invalid',
      MYSQL_WRITER_URL: 'invalid-private-mysql',
      POS_SCREENING_COUNTER_GENERATION_READER_KEY_FILE: '/unreadable-private-reader.json',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({
      module: 'legacy-order-imports',
      resource: 'screening-counter-generation',
      eventId: 'legacy-order-imports.screening-counter-generation.disabled',
      status: 'disabled',
      userId: null,
    });
    expect(result.stdout).not.toMatch(/invalid-private|unreadable-private|mysql:\/\//);
  });
  it('refuses selected demo mode with one sanitized failure and no secret/driver payload', () => {
    const result = run({
      ...generationEnvironment(),
      DEMO_MODE: 'true',
      MYSQL_WRITER_URL:
        'mysql://synthetic-private-user:synthetic-private-password@invalid-host/private_customer',
      POS_SCREENING_COUNTER_GENERATION_WRITER_KEY_FILE: '/synthetic-private-key.json',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr) as unknown).toMatchObject({
      module: 'legacy-order-imports',
      resource: 'screening-counter-generation',
      eventId: 'legacy-order-imports.screening-counter-generation.startup-failed',
      status: 'startup-failed',
      userId: null,
    });
    expect(result.stderr).not.toMatch(
      /synthetic-private|invalid-host|private_customer|Error:|stack|Bearer/,
    );
  });
});
