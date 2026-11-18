/** Private, disposable fixture handoff. Never supplies runtime credentials. */
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
export function readNativeMembershipAccount(adminUrl: string) {
  const admin = new URL(adminUrl);
  const file = z.string().min(1).parse(process.env.POS_IMPORT_NATIVE_ACCOUNT_FILE);
  const info = statSync(file);
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 64000)
    throw new Error('Private fixture authority required.');
  const account = z
    .object({
      environment: z.record(z.string(), z.string()),
      applicationUrl: z.string(),
    })
    .strict()
    .parse(JSON.parse(readFileSync(file, 'utf8')));
  const app = new URL(account.applicationUrl);
  if (
    admin.protocol !== 'mysql:' ||
    !['127.0.0.1', 'localhost'].includes(admin.hostname) ||
    !/^\/(?:pos_checkout_contract_test|pos_rewrite_import_runtime_[a-f0-9]{12})$/.test(
      admin.pathname,
    ) ||
    app.protocol !== 'mysql:' ||
    app.hostname !== admin.hostname ||
    app.port !== admin.port ||
    app.pathname !== admin.pathname ||
    !/^nh_app_[a-z0-9]+$/.test(decodeURIComponent(app.username)) ||
    !app.password ||
    app.search ||
    app.hash
  )
    throw new Error('Independent disposable fixture account required.');
  return { applicationUrl: app.href, environment: account.environment };
}
