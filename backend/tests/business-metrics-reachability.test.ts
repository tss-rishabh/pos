import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { z } from 'zod';

it('keeps both BD prototype templates inventoried and proves their views/routes/navigation are inactive at the pinned source', () => {
  const result = spawnSync('python3', ['tools/parity/check_business_metrics_reachability.py'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const value = z
    .object({
      sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
      activeViewDefinitions: z.literal(0),
      registeredRoutes: z.literal(0),
      activeTemplateReferences: z.literal(0),
      sidebarLink: z.literal('inside-django-comment'),
      templatesRetained: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
      applicationImported: z.literal(false),
      externalRequests: z.literal(0),
    })
    .strict()
    .parse(JSON.parse(result.stdout) as unknown);
  expect(value.templatesRetained).toEqual({
    'report/templates/bd_report/daily_report_matric_upload.html':
      'd3561050e5bc4cf546034d8a6e116188bb85646d7d34bd3bf8c8ff1beb22b6e9',
    'report/templates/bd_report/daily_report_matric_report_datatable.html':
      '078abfea76f93aef10bb2d3a0dbd4dff66eeed53e41e8ab2ffe7f9399eb2b806',
  });
});
