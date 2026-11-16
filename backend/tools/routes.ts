import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { resourceRoutes } from '../src/observability/events.js';

const app = await buildApp(
  readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'manifest-only-local-tool-'.repeat(3),
  }),
);
try {
  await app.ready();
  const routes = resourceRoutes(app);
  console.log(
    JSON.stringify(
      {
        apiRoutes: routes.length,
        byModule: Object.fromEntries(
          [...new Set(routes.map((route) => route.module))]
            .sort()
            .map((module) => [module, routes.filter((route) => route.module === module).length]),
        ),
        routes,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
