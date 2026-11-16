import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(
  new URL('../../compatibility/upstream/customer-website-handoff/', import.meta.url),
);
const docker = (args) =>
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--mount',
      `type=bind,source=${directory},target=/slice,readonly`,
      'php:5.6-cli',
      'php',
      ...args,
    ],
    { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
for (const file of ['PosWebsiteHandoff.php', 'routes.review.php', 'receiver_test.php'])
  docker(['-l', '/slice/' + file]);
const result = JSON.parse(docker(['/slice/receiver_test.php']));
if (
  result.passed !== true ||
  result.network !== false ||
  !Number.isInteger(result.checks) ||
  result.checks < 20
)
  throw new Error('Synthetic website receiver checks failed.');
process.stdout.write(
  JSON.stringify({ resource: 'customer-website-handoff-receiver', ...result }) + '\n',
);
