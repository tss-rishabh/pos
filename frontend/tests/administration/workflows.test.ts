import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Guide } from '../../src/pages/administration/documentation-api';
import type { DeliverySlot, GeneralSetting } from '../../src/pages/administration/settings-api';
import type { UploadDetail, UploadSummary } from '../../src/pages/administration/import-api';

describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'administration browser workflows with isolated API fixtures',
  () => {
    let server: ViteDevServer, browser: Browser, origin: string, cacheDir: string;
    const imageBytes = readFileSync(new URL('./fixtures/private-image.png', import.meta.url));
    beforeAll(async () => {
      cacheDir = await mkdtemp(join(tmpdir(), 'pos-administration-browser-'));
      server = await createServer({
        configFile: false,
        cacheDir,
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (
          ![
            '/__administration-test__',
            '/application-links/staff',
            '/application-links/customer',
          ].includes(request.url?.split('?')[0] || '')
        ) {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__administration-test__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/administration/browser-harness.tsx"></script></body></html>',
          );
          response.setHeader('Content-Type', 'text/html');
          response.setHeader(
            'Content-Security-Policy',
            `default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ${origin.replace('http:', 'ws:')} https://upload.example.test; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-src 'self' blob:`,
          );
          response.end(html);
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Isolated browser server did not bind a local port.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
      if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
    });

    async function fixture(
      page: Page,
      screen:
        | 'administration'
        | 'documentation'
        | 'profile-images'
        | 'application-links'
        | 'permission-history' = 'administration',
      applicationScreen?: 'staff' | 'customer',
    ) {
      page.setDefaultTimeout(5000);
      const initialGuide: Guide = {
        id: '100',
        title: 'Fixture guide',
        summary: 'Fixture summary',
        description: '<p>Read the steps.</p>',
        descriptionHtml: '<p>Read the steps.</p>',
        keywords: 'fixture',
        sortOrder: 0,
        active: 1,
        version: '2026-11-16 00:00:00',
        assets: [],
        mediaState: 'available',
        updatedAt: '2026-11-16T00:00:00Z',
        uploaderName: 'Fixture administrator',
      };
      const state = {
        accessReconciled: true,
        expectedRequestActor: '1',
        deniedActors: [] as string[],
        accessGroups: [
          {
            id: '9fe9367d-9a88-40ec-b557-3d75fbd5a02a',
            name: 'Fixture source readers',
            permissionKeys: ['stores.view_store'],
            memberCount: '0',
            version: 'c'.repeat(64),
          },
        ],
        operatorAccess: {
          id: '4',
          isStaff: false,
          isSuperuser: false,
          groupIds: [] as string[],
          permissionKeys: [] as string[],
          version: 'd'.repeat(64),
        },
        operatorProfile: {
          id: '4',
          username: 'fixture4',
          firstName: 'Fixture',
          lastName: 'Operator',
          email: 'fixture4@example.test',
          phone: '9876543204',
          contactEmail: 'contact4@example.test',
          age: null as number | null,
          gender: null as string | null,
          role: 4,
          userType: 1,
          otpMethod: 2,
          active: true,
          isStaff: false,
          isSuperuser: false,
          mfaEnabled: false,
          passwordConfigured: true,
          lastLogin: null as string | null,
          dateJoined: '2000-01-01 12:13:14.123456',
          timeZone: 'Asia/Kolkata',
          revision: '9'.repeat(64),
          imagesAvailable: true,
          hasProfileImage: false,
          hasCoverImage: false,
          canEdit: true,
          canResetPassword: true,
        },
        profileRevision: 'a'.repeat(64),
        profileHasImage: false,
        profileHasCover: false,
        storeImageRevision: 'b'.repeat(64),
        storeHasImage: false,
        storeSlackConfigured: true,
        storeCityId: 0,
        slackAttemptId: '',
        slackState: 'PENDING' as 'PENDING' | 'EXCHANGING' | 'COMPLETED' | 'CANCELLED',
        postalLookups: [] as string[],
        dropImageAttachmentResponse: false,
        imageUploads: [] as {
          id: string;
          kind: string;
          revision: string;
          scope: 'profile' | 'store' | 'managed';
          checksum: string;
          size: number;
          attached: boolean;
        }[],
        imageAttachmentAttempts: [] as string[],
        mfaEnabled: false,
        mfaConfigured: false,
        mfaVersion: 'f'.repeat(64),
        mfaEnrollmentId: '',
        imports: [
          {
            id: '41',
            uploadType: 'PRODUCT_STOCK_CSV',
            uploadedBy: '1',
            uploaderName: 'Fixture administrator',
            message: 'Product Stock Data Updated Successfully.',
            isImported: true,
            createdAt: '2000-01-01 00:00:00',
            updatedAt: '2000-01-01 00:00:01',
          },
        ] as UploadSummary[],
        importUploads: [] as { type: string; name: string; csv: string }[],
        guides: [initialGuide],
        guideUploads: [] as { id: string; name: string; checksum: string; contentType: string }[],
        s3Posts: 0,
        s3Cookie: undefined as string | undefined,
        operatorStoreIds: ['1'],
        terminalActive: true,
        terminalTotal: 1,
        terminalChangedCount: false,
        terminalSearches: [] as { start: number; length: number }[],
        terminalExists: true,
        settings: [
          {
            name: 'HYPERLOCAL_STOCK_THRESHOLD',
            value: '2',
            version: 'a'.repeat(64),
            configured: true,
            editable: true,
          },
          {
            name: 'ORDER_CREATION_BUFFER_TIME_IN_SEC',
            value: '60',
            version: 'b'.repeat(64),
            configured: true,
            editable: true,
          },
        ] as GeneralSetting[],
        slots: [
          {
            id: '30',
            weekday: 'MON',
            start: '09:00:15',
            end: '22:00:00',
            available: 1,
            version: 'c'.repeat(64),
            editable: true,
            availabilityEditable: true,
          },
          {
            id: '31',
            weekday: 'TUE',
            start: '09:00:00',
            end: '22:00:00',
            available: 1,
            version: 'd'.repeat(64),
            editable: true,
            availabilityEditable: true,
          },
        ] as DeliverySlot[],
        mutations: [] as { path: string; method: string; body: unknown }[],
        collectionMode: false,
        collectionSearches: [] as {
          path: string;
          after: string;
          limit: number;
          active?: string;
          sort?: string;
          direction?: 'asc' | 'desc';
          search: string;
        }[],
        exportInputs: [] as { commandId: string; input: unknown }[],
        personSearches: [] as { path: string; search: string; url: string }[],
        activitySearches: [] as {
          url: string;
          input: {
            from: string | null;
            to: string | null;
            search: string;
            platforms: string[];
            start: number;
            length: number;
          };
        }[],
        activityUnavailable: false,
        staffApplicationAvailable: true,
        customerApplicationAvailable: true,
        applicationCheckedInStore: '1' as string | null,
        applicationGrantId: 'b9907c09-2f70-4341-9aa4-5755c306e18c',
        applicationRequests: [] as {
          path: string;
          method: string;
          body: unknown;
          cookie: string | undefined;
          url: string;
        }[],
        applicationBinaryFailures: 0,
        applicationActivationOperation: '',
        applicationDownloadOperation: '',
        console: [] as string[],
      };
      page.on('console', (message) => state.console.push(message.text()));
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          privateSearch =
            request.method() === 'POST' &&
            /^\/api\/v1\/(?:admin\/(?:(?:operators|salespeople|stores|counters|storages)|stores\/\d+\/(?:counters|storages)|access\/(?:groups|permissions))|documentation)\/search$/.test(
              url.pathname,
            ),
          path = privateSearch ? url.pathname.replace(/\/search$/, '') : url.pathname,
          method = privateSearch ? 'GET' : request.method();
        let pageInput: {
          after: string;
          limit: number;
          active?: string;
          sort?: string;
          direction?: 'asc' | 'desc';
          search: string;
        } | null = null;
        if (privateSearch) {
          const input = z
            .object({
              after: z.string(),
              limit: z.number(),
              active: z.string().optional(),
              search: z.string(),
              sort: z.string().optional(),
              direction: z.enum(['asc', 'desc']).optional(),
            })
            .strict()
            .parse(request.postDataJSON() as unknown);
          pageInput = input;
          state.collectionSearches.push({ path: url.pathname, ...input });
          state.personSearches.push({
            path: url.pathname,
            search: input.search,
            url: request.url(),
          });
          expect(url.search).toBe('');
        }
        const json = (value: unknown, status = 200) =>
          route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
        if (path === '/api/v1/report-exports' && method === 'POST') {
          const input = z
            .object({ commandId: z.uuid(), input: z.unknown() })
            .strict()
            .parse(request.postDataJSON() as unknown);
          state.exportInputs.push(input);
          return json(
            {
              id: input.commandId,
              origin: 'current',
              kind: 'administration-list',
              reportName: 'Synthetic collection',
              from: null,
              to: null,
              status: 'QUEUED',
              message: 'Queued',
              requestedBy: '1',
              requestedAt: '2026-11-18T00:00:00Z',
              completedAt: null,
              format: 'CSV',
              byteCount: null,
              rowCount: null,
              canDownload: false,
            },
            202,
          );
        }

        if (
          path.startsWith('/api/v1/operators/current/application-links') ||
          path.startsWith('/api/v1/auth/application-links')
        ) {
          const body: unknown = request.postData()
            ? (request.postDataJSON() as unknown)
            : undefined;
          state.applicationRequests.push({
            path,
            method,
            body,
            cookie: request.headers().cookie,
            url: request.url(),
          });
          expect(url.search).toBe('');
          if (path.startsWith('/api/v1/operators/'))
            expect(request.headers()['x-operator-id']).toBe('1');
          else {
            expect(request.headers()['x-operator-id']).toBeUndefined();
            expect(request.headers().cookie).toBeUndefined();
          }
          if (path.endsWith('/capabilities'))
            return json({
              staffAvailable: state.staffApplicationAvailable,
              customerAvailable: state.customerApplicationAvailable,
              checkedInStore: state.applicationCheckedInStore,
              qrPeriodSeconds: 60,
            });
          if (path.endsWith('/staff-qr') && method === 'POST')
            return json({
              id: state.applicationGrantId,
              url: origin + '/application-links/staff#' + 'A'.repeat(43),
              qrDataUrl: 'data:image/png;base64,' + imageBytes.toString('base64'),
              serverNow: Date.now(),
              expiresAt: Date.now() + 60000,
            });
          if (path.endsWith('/customer-qr'))
            return json({
              storeId: '1',
              storeName: 'Fixture checked-in store',
              url: origin + '/application-links/customer#1.' + 'C'.repeat(43),
              qrDataUrl: 'data:image/png;base64,' + imageBytes.toString('base64'),
            });
          if (path.endsWith('/staff-download-activations')) {
            const input = z
              .object({ token: z.string(), operationId: z.uuid() })
              .strict()
              .parse(body);
            if (state.applicationActivationOperation)
              expect(input.operationId).toBe(state.applicationActivationOperation);
            state.applicationActivationOperation = input.operationId;
            return json({
              activationToken: 'B'.repeat(43),
              serverNow: Date.now(),
              expiresAt: Date.now() + 60000,
            });
          }
          if (path.endsWith('/staff-download-content')) {
            const input = z
              .object({ activationToken: z.string(), operationId: z.uuid() })
              .strict()
              .parse(body);
            if (state.applicationDownloadOperation)
              expect(input.operationId).toBe(state.applicationDownloadOperation);
            state.applicationDownloadOperation = input.operationId;
            if (state.applicationBinaryFailures > 0) {
              state.applicationBinaryFailures--;
              return route.abort('connectionreset');
            }
            return route.fulfill({
              status: 200,
              contentType: 'application/vnd.android.package-archive',
              headers: { 'Content-Length': '4' },
              body: Buffer.from([80, 75, 3, 4]),
            });
          }
          if (path.endsWith('/customer-scans'))
            return json({ destination: 'https://www.thesouledstore.com/app/fixture-customer' });
          throw new Error('Unexpected application-link fixture route.');
        }
        if (path === '/api/v1/admin/special-permission-activity/capabilities' && method === 'GET')
          return json({
            today: '2026-11-16',
            platforms: ['barcode', 'Tss Money', 'Tss Points', 'Gift Voucher', 'Gift Card'],
            historyConfigured: true,
          });
        if (path === '/api/v1/admin/special-permission-activity/search' && method === 'POST') {
          expect(request.headers()['x-operator-id']).toBe('1');
          expect(url.search).toBe('');
          const input = z
            .object({
              from: z.string().nullable(),
              to: z.string().nullable(),
              search: z.string(),
              platforms: z.array(z.string()),
              start: z.number(),
              length: z.number(),
              draw: z.number(),
            })
            .strict()
            .parse(request.postDataJSON() as unknown);
          state.activitySearches.push({ url: request.url(), input });
          const reader =
            input.from === '2026-11-16' && input.to === '2026-11-16' ? 'data-reader' : 'bigquery';
          if (reader === 'bigquery' && state.activityUnavailable)
            return json(
              {
                error: {
                  code: 'SPECIAL_PERMISSION_HISTORY_UNAVAILABLE',
                  message:
                    'Historical activity is temporarily unavailable. Choose today or try again later.',
                },
              },
              503,
            );
          const data = Array.from({ length: 13 }, (_, index) => ({
            id: String(9007199254740993n + BigInt(index)),
            addedBy: index === 0 ? ' ' : index === 1 ? 'unknown' : '  Saved Actor  ',
            platform: index % 2 ? 'Tss Money' : 'barcode',
            recipient: index === 0 ? 'NA' : index === 1 ? 'customer.fixture@example.test' : '  ',
            comment: index === 0 ? '=SUM(1,2)' : 'Fixture activity ' + index,
            createdAt: '2026-11-16T12:00:00',
          })).filter(
            (row) =>
              (!input.platforms.length || input.platforms.includes(row.platform)) &&
              (!input.search ||
                [row.platform, row.recipient, row.comment, row.createdAt].some((value) =>
                  value.toLowerCase().includes(input.search.toLowerCase()),
                )),
          );
          const start =
            input.start < 0 || input.start % input.length || input.start >= data.length
              ? 0
              : input.start;
          return json({
            reader,
            today: '2026-11-16',
            draw: input.draw,
            recordsTotal: String(data.length),
            recordsFiltered: String(data.length),
            start,
            length: input.length,
            data: data.slice(start, start + input.length),
          });
        }
        if (path === '/api/v1/admin/payment-terminals/search' && method === 'POST') {
          expect(request.headers()['x-operator-id']).toBe(state.expectedRequestActor);
          const input = z
            .object({
              start: z.number(),
              length: z.number(),
              provider: z.string(),
              storeId: z.string().optional(),
              search: z.string(),
              sort: z.string(),
              direction: z.string(),
            })
            .strict()
            .parse(request.postDataJSON());
          state.terminalSearches.push(input);
          const total = state.terminalExists ? state.terminalTotal : 0;
          const data = Array.from(
            { length: Math.max(0, Math.min(input.length, total - input.start)) },
            (_, index) => ({
              id: String(10 + input.start + index),
              provider: 'paytm',
              name: input.start + index === 0 ? 'Machine 1' : `Machine ${input.start + index + 1}`,
              merchantName: '=Fixture merchant',
              channelId: 'fixture-channel',
              hardwareId: 'fixture-mid',
              imei: '',
              deviceSerialNumber: '9223372036854775807',
              terminalId: 'fixture-terminal',
              merchantId: '',
              storeCode: 'FX1',
              storeName: 'Fixture Store One',
              storeId: '1',
              active: state.terminalActive ? 1 : 0,
            }),
          );
          return json({
            data,
            total: state.terminalChangedCount && input.start ? total + 1 : total,
            start: input.start,
            length: input.length,
          });
        }
        if (method !== 'GET') {
          if (request.headers()['x-operator-id'] !== state.expectedRequestActor) {
            state.deniedActors.push(request.headers()['x-operator-id'] || 'missing');
            return json(
              {
                error: {
                  code: 'OPERATOR_CHANGED',
                  message: 'The signed-in operator changed. Sign in again.',
                },
              },
              409,
            );
          }
          expect(request.headers()['x-operator-id']).toBe('1');
          const body: unknown = request.postData()
            ? (request.postDataJSON() as unknown)
            : undefined;
          state.mutations.push({ path, method, body });
          if (path === '/api/v1/locations/postal-code-lookups' && method === 'POST') {
            const input = z.object({ postalCode: z.string() }).strict().parse(body);
            state.postalLookups.push(input.postalCode);
            return json({
              status: 'success',
              message: 'location fetched',
              data:
                input.postalCode === '400001'
                  ? {
                      postalCode: '400001',
                      city: 'Mumbai',
                      state: 'Fixture state',
                      country: 'Fixture country',
                      countryId: '99',
                      stateId: '42',
                      latitude: '19.0000000000000001',
                      longitude: '72.0000000000000001',
                    }
                  : null,
            });
          }
          if (path === '/api/v1/admin/stores/1/slack-connections' && method === 'POST') {
            const input = z
              .object({ operationId: z.uuid(), expectedVersion: z.string() })
              .strict()
              .parse(body);
            expect(input.expectedVersion).toBe('f'.repeat(64));
            state.slackAttemptId = input.operationId;
            state.slackState = 'PENDING';
            return json(
              {
                id: input.operationId,
                expiresAt: Date.now() + 600000,
                authorizationUrl:
                  'https://slack.com/oauth/v2/authorize?' +
                  new URLSearchParams({
                    client_id: '1234.5678',
                    scope: 'incoming-webhook',
                    redirect_uri: origin + '/api/v1/admin/slack/oauth/callback',
                    state: 'h'.repeat(43),
                  }),
              },
              201,
            );
          }
          if (
            path === `/api/v1/admin/slack/connections/${state.slackAttemptId}/cancellation` &&
            method === 'POST'
          ) {
            state.slackState = 'CANCELLED';
            return json({
              id: state.slackAttemptId,
              storeId: '1',
              state: state.slackState,
              errorCode: 'SLACK_CONNECTION_CANCELLED',
              channel: null,
              expiresAt: Date.now() + 600000,
            });
          }
          if (path === '/api/v1/admin/operators/4/administrative-profile' && method === 'PUT') {
            const input = z
              .object({
                operationId: z.uuid(),
                expectedVersion: z.string(),
                username: z.string(),
                firstName: z.string(),
                lastName: z.string(),
                email: z.string(),
                phone: z.string(),
                contactEmail: z.string(),
                age: z.number().nullable(),
                gender: z.string().nullable(),
                role: z.number(),
                userType: z.number(),
                otpMethod: z.number(),
                active: z.boolean(),
                lastLogin: z.string(),
                dateJoined: z.string(),
              })
              .strict()
              .parse(body);
            expect(input.expectedVersion).toBe(state.operatorProfile.revision);
            state.operatorProfile = {
              ...state.operatorProfile,
              ...input,
              lastLogin: input.lastLogin || null,
              revision: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
            };
            return json({
              id: '4',
              status: 'success',
              message: 'Operator administrative profile saved.',
              credentialsChanged: true,
            });
          }
          if (path === '/api/v1/admin/operators/4/password-resets' && method === 'POST') {
            const input = z
              .object({
                operationId: z.uuid(),
                expectedVersion: z.string(),
                newPassword: z.string().min(8),
                confirmation: z.string(),
              })
              .strict()
              .parse(body);
            expect(input.expectedVersion).toBe(state.operatorProfile.revision);
            expect(input.confirmation).toBe(input.newPassword);
            state.operatorProfile.revision = createHash('sha256')
              .update(input.operationId)
              .digest('hex');
            return json({
              id: '4',
              status: 'success',
              message: 'Operator password reset. Existing authentication was revoked.',
              credentialsChanged: true,
            });
          }
          if (
            method === 'POST' &&
            [
              '/api/v1/operators/current/profile/image-uploads',
              '/api/v1/admin/stores/1/image-uploads',
              '/api/v1/admin/operators/4/profile/image-uploads',
            ].includes(path)
          ) {
            const input = z
              .object({
                revision: z.string(),
                upload: z.object({
                  id: z.uuid(),
                  kind: z.enum(['image', 'cover-image']),
                  name: z.string(),
                  contentType: z.literal('image/png'),
                  size: z.number(),
                  checksum: z.string(),
                }),
              })
              .strict()
              .parse(body);
            const scope = path.includes('/admin/operators/')
              ? ('managed' as const)
              : path.includes('/profile/')
                ? ('profile' as const)
                : ('store' as const);
            expect(input.revision).toBe(
              scope === 'managed'
                ? state.operatorProfile.revision
                : scope === 'profile'
                  ? state.profileRevision
                  : state.storeImageRevision,
            );
            state.imageUploads.push({
              id: input.upload.id,
              kind: input.upload.kind,
              revision: input.revision,
              scope,
              checksum: input.upload.checksum,
              size: input.upload.size,
              attached: false,
            });
            return json({
              id: input.upload.id,
              expiresAt: Date.now() + 15 * 60000,
              url: 'https://upload.example.test/',
              fields: { key: `fixture-images/${input.upload.id}.png` },
            });
          }
          if (
            method === 'POST' &&
            /^\/api\/v1\/(?:operators\/current\/profile|admin\/stores\/1|admin\/operators\/4\/profile)\/image-uploads\/[0-9a-f-]+\/attachment$/.test(
              path,
            )
          ) {
            const input = z.object({ revision: z.string() }).strict().parse(body),
              id = path.split('/').at(-2)!,
              upload = state.imageUploads.find((record) => record.id === id)!;
            expect(input.revision).toBe(upload.revision);
            state.imageAttachmentAttempts.push(id);
            upload.attached = true;
            if (upload.scope === 'managed') {
              state.operatorProfile.revision = createHash('sha256').update(id).digest('hex');
              if (upload.kind === 'image') state.operatorProfile.hasProfileImage = true;
              else state.operatorProfile.hasCoverImage = true;
            } else if (upload.scope === 'profile') {
              state.profileRevision = createHash('sha256').update(id).digest('hex');
              if (upload.kind === 'image') state.profileHasImage = true;
              else state.profileHasCover = true;
            } else {
              state.storeImageRevision = createHash('sha256').update(id).digest('hex');
              state.storeHasImage = true;
            }
            if (state.dropImageAttachmentResponse) {
              state.dropImageAttachmentResponse = false;
              return route.abort('connectionfailed');
            }
            return json(
              upload.scope === 'managed'
                ? { profile: state.operatorProfile }
                : upload.scope === 'profile'
                  ? {
                      profile: { revision: state.profileRevision },
                      sessionExpiresAt: Date.now() + 60000,
                    }
                  : {
                      status: 'success',
                      image: {
                        revision: state.storeImageRevision,
                        available: true,
                        hasImage: true,
                      },
                    },
            );
          }
          if (path === '/api/v1/admin/stores' && method === 'POST')
            return json({ id: '2', message: 'Store has been created!' }, 201);
          if (path === '/api/v1/admin/stores/1' && method === 'PUT') {
            const input = z.object({ slackUrl: z.string(), removeSlack: z.boolean() }).parse(body);
            if (input.removeSlack) state.storeSlackConfigured = false;
            else if (input.slackUrl) state.storeSlackConfigured = true;
            return json({ id: '1', status: 'success', message: 'Store saved.' });
          }
          if (path === '/api/v1/admin/operators/4/mfa-enrollments' && method === 'POST') {
            const input = z
              .object({ operationId: z.uuid(), expectedVersion: z.string() })
              .strict()
              .parse(body);
            expect(input.expectedVersion).toBe(state.mfaVersion);
            state.mfaEnrollmentId = input.operationId;
            return json(
              {
                id: input.operationId,
                expiresAt: '2099-01-01T00:00:00Z',
                qrDataUrl:
                  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6XU8AAAAASUVORK5CYII=',
              },
              201,
            );
          }
          if (
            path ===
              `/api/v1/admin/operators/4/mfa-enrollments/${state.mfaEnrollmentId}/verification` &&
            method === 'POST'
          ) {
            const input = z
              .object({ code: z.string().regex(/^\d{6}$/) })
              .strict()
              .parse(body);
            if (input.code !== '123456')
              return json(
                { error: { code: 'MFA_CODE_INVALID', message: 'Wrong OTP, Enter correct OTP' } },
                422,
              );
            state.mfaEnabled = true;
            state.mfaConfigured = true;
            state.mfaVersion = 'e'.repeat(64);
            return json({ status: 'success', message: 'MFA activated on your account' });
          }
          if (path === '/api/v1/admin/operators/4/mfa' && method === 'PUT') {
            const input = z
              .discriminatedUnion('mode', [
                z
                  .object({
                    operationId: z.uuid(),
                    expectedVersion: z.string(),
                    mode: z.literal('disable'),
                  })
                  .strict(),
                z
                  .object({
                    operationId: z.uuid(),
                    expectedVersion: z.string(),
                    mode: z.literal('replace'),
                    secret: z.string().regex(/^[A-Z2-7]{32,128}$/),
                    code: z.literal('123456'),
                  })
                  .strict(),
              ])
              .parse(body);
            expect(input.expectedVersion).toBe(state.mfaVersion);
            state.mfaEnabled = input.mode === 'replace';
            state.mfaConfigured = input.mode === 'replace';
            state.mfaVersion = createHash('sha256').update(JSON.stringify(input)).digest('hex');
            return json({
              status: 'success',
              message:
                input.mode === 'replace' ? 'Authenticator replaced.' : 'Authenticator disabled.',
            });
          }
          if (path === '/api/v1/admin/inventory-imports' && method === 'POST') {
            const input = z
              .object({ type: z.literal('PRODUCT_STOCK_CSV'), name: z.string(), csv: z.string() })
              .strict()
              .parse(body);
            state.importUploads.push(input);
            state.imports.unshift({
              ...state.imports[0]!,
              id: String(42 + state.importUploads.length),
              message: null,
              isImported: false,
            });
            return json(
              {
                id: state.imports[0]!.id,
                message: 'Csv Uploaded successfully. Data may take some time to reflect.',
              },
              201,
            );
          }
          if (path === '/api/v1/admin/documentation/uploads' && method === 'POST') {
            const upload = z
              .object({
                id: z.uuid(),
                name: z.string(),
                checksum: z.string(),
                contentType: z.string(),
              })
              .parse(body);
            state.guideUploads.push(upload);
            return json(
              {
                id: upload.id,
                expiresAt: '2026-11-16T01:00:00Z',
                upload: {
                  url: 'https://upload.example.test/',
                  fields: { key: 'fixture-upload-key' },
                },
              },
              201,
            );
          }
          if (
            /^\/api\/v1\/admin\/documentation\/uploads\/[0-9a-f-]+\/complete$/.test(path) &&
            method === 'POST'
          )
            return json({ id: path.split('/').at(-2), status: 'success' });
          if (path === '/api/v1/admin/documentation' && method === 'POST') {
            const input = z
              .object({
                title: z.string(),
                summary: z.string(),
                description: z.string(),
                keywords: z.string(),
                sortOrder: z.number(),
                uploadIds: z.array(z.string()),
              })
              .parse(body);
            const guide: Guide = {
              ...initialGuide,
              id: '101',
              title: input.title,
              summary: input.summary,
              description: input.description,
              descriptionHtml: input.description + '<script>window.alert("script-canary")</script>',
              keywords: input.keywords,
              sortOrder: input.sortOrder,
              assets: input.uploadIds.map((id) => ({
                id,
                kind: 'document',
                name: state.guideUploads.find((upload) => upload.id === id)?.name || 'Fixture.pdf',
                contentType: 'application/pdf',
                url: `/api/v1/documentation/101/assets/${id}/content`,
              })),
            };
            state.guides.unshift(guide);
            return json({ id: guide.id, version: guide.version }, 201);
          }
          if (path === '/api/v1/admin/operators/4/stores') {
            state.operatorStoreIds = z
              .object({ storeIds: z.array(z.string()) })
              .parse(body).storeIds;
            return json({ status: 'success', message: 'Store access updated.' });
          }
          if (path === '/api/v1/admin/general-settings/order-creation-buffer' && method === 'PUT') {
            const input = z
              .object({ operationId: z.uuid(), expectedVersion: z.string(), value: z.string() })
              .parse(body);
            const setting = state.settings.find(
              (value) => value.name === 'ORDER_CREATION_BUFFER_TIME_IN_SEC',
            )!;
            if (setting.version !== input.expectedVersion)
              return json(
                { error: { code: 'SETTINGS_CONFLICT', message: 'Refresh settings.' } },
                409,
              );
            const [hours, minutes] = input.value.split(':').map(Number);
            setting.value = String(hours! * 3600 + minutes! * 60);
            setting.version = createHash('sha256').update(JSON.stringify(input)).digest('hex');
            return json({ status: 'success', message: 'Settings saved.', effectsQueued: true });
          }
          if (path === '/api/v1/admin/stores/1/delivery-slots/30' && method === 'PUT') {
            const input = z
              .object({
                operationId: z.uuid(),
                expectedVersion: z.string(),
                weekday: z.string(),
                start: z.string(),
                end: z.string(),
                destinationStoreId: z.string(),
              })
              .parse(body);
            if (input.expectedVersion !== state.slots[0]!.version)
              return json(
                { error: { code: 'SETTINGS_CONFLICT', message: 'Refresh timings.' } },
                409,
              );
            state.slots[0] = {
              ...state.slots[0]!,
              weekday: input.weekday,
              start: input.start,
              end: input.end,
              version: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
            };
            return json({
              status: 'success',
              message: 'Delivery timings saved.',
              effectsQueued: true,
            });
          }
          if (path === '/api/v1/admin/stores/1/delivery-slots/availability' && method === 'PATCH') {
            const input = z
              .object({
                operationId: z.uuid(),
                active: z.boolean(),
                expectedSlots: z.array(z.object({ id: z.string(), version: z.string() })),
              })
              .parse(body);
            if (
              state.slots.some(
                (slot) =>
                  !input.expectedSlots.some(
                    (expected) => expected.id === slot.id && expected.version === slot.version,
                  ),
              )
            )
              return json(
                { error: { code: 'SETTINGS_CONFLICT', message: 'Refresh timings.' } },
                409,
              );
            state.slots = state.slots.map((slot) => ({ ...slot, available: input.active ? 1 : 0 }));
            return json({ status: 'success', message: 'Updated', effectsQueued: true });
          }
          if (path === '/api/v1/admin/stores/1/payment-terminals/paytm/10' && method === 'PUT') {
            state.terminalActive = z.object({ active: z.boolean() }).parse(body).active;
            return json({ id: '10', status: 'success', message: 'Terminal updated.' });
          }
          if (path === '/api/v1/admin/stores/1/payment-terminals/paytm/10' && method === 'DELETE') {
            state.terminalExists = false;
            return json({ status: 'success', message: 'Paytm Machine deleted' });
          }
          return json(
            {
              error: {
                code: 'FIXTURE_MUTATION_NOT_FOUND',
                message: 'Fixture mutation is unavailable.',
              },
            },
            404,
          );
        }
        if (path === '/api/v1/admin/stores/1/slack-connection')
          return json({
            enabled: true,
            configured: state.storeSlackConfigured,
            version: 'f'.repeat(64),
          });
        if (path === `/api/v1/admin/slack/connections/${state.slackAttemptId}`)
          return json({
            id: state.slackAttemptId,
            storeId: '1',
            state: state.slackState,
            errorCode: null,
            channel: state.slackState === 'COMPLETED' ? '#fixture-sales' : null,
            expiresAt: Date.now() + 600000,
          });
        if (path === '/api/v1/admin/slack/oauth/callback') {
          expect(url.searchParams.get('state')).toBe('h'.repeat(43));
          state.slackState = 'COMPLETED';
          state.storeSlackConfigured = true;
          return route.fulfill({
            status: 303,
            headers: {
              location: origin + '/__administration-test__?slackConnection=' + state.slackAttemptId,
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
            },
          });
        }
        if (path === '/api/v1/admin/operator-administration/capabilities')
          return json({ canViewOperators: state.accessReconciled });
        if (path === '/api/v1/admin/operators/4/administrative-profile')
          return json(state.operatorProfile);
        if (path === '/api/v1/operators/current/profile')
          return json({
            profile: {
              revision: state.profileRevision,
              imagesAvailable: true,
              hasProfileImage: state.profileHasImage,
              hasCoverImage: state.profileHasCover,
            },
            sessionExpiresAt: Date.now() + 60000,
          });
        if (
          /^\/api\/v1\/operators\/current\/profile\/images\/(?:image|cover-image)$/.test(path) ||
          /^\/api\/v1\/admin\/operators\/4\/profile\/images\/(?:image|cover-image)$/.test(path) ||
          path === '/api/v1/admin/stores/1/image/content'
        )
          return route.fulfill({
            status: 200,
            contentType: 'image/png',
            headers: { 'cache-control': 'private, no-store' },
            body: imageBytes,
          });
        if (path === '/api/v1/admin/stores/1/image')
          return json({
            revision: state.storeImageRevision,
            available: true,
            hasImage: state.storeHasImage,
          });
        if (path === '/api/v1/admin/franchises')
          return json({
            data: [
              {
                id: '20',
                name: 'Existing fixture franchise',
                description: 'Shared details',
                cin: 'FIXTURE-CIN',
              },
            ],
            nextCursor: null,
          });
        if (path === '/api/v1/admin/operators/4/mfa')
          return json({
            enabled: state.mfaEnabled,
            configured: state.mfaConfigured,
            version: state.mfaVersion,
            canReplace: true,
          });
        if (path === '/api/v1/stores')
          return json({
            data: [
              {
                id: '1',
                name: 'Fixture Store One',
                locationCode: 'ONE',
                city: 'Fixture city',
                active: true,
              },
              {
                id: '2',
                name: 'Fixture Store Two',
                locationCode: 'TWO',
                city: 'Fixture city',
                active: true,
              },
            ],
          });
        if (path === '/api/v1/admin/inventory-imports/capabilities')
          return json({
            maximumBytes: 262144,
            maximumRows: 5000,
            visibilityEnabled: true,
            stockEnabled: false,
            historyEnabled: true,
          });
        if (path === '/api/v1/admin/inventory-imports')
          return json({ data: state.imports, nextBefore: null });
        if (/^\/api\/v1\/admin\/inventory-imports\/\d+$/.test(path)) {
          const upload = state.imports.find((row) => row.id === path.split('/').at(-1))!;
          return json({
            ...upload,
            failedData: upload.isImported
              ? [
                  {
                    data: {
                      SkuId: 'x',
                      StoreId: '1',
                      IsHold: '',
                      'Hold/UnholdQty': '',
                      IsAvailable: '',
                      IsDelete: '',
                    },
                    message: 'Error while traversing csv data.',
                    other_error: "invalid literal for int() with base 10: 'x'",
                  },
                ]
              : null,
          } satisfies UploadDetail);
        }
        if (path === '/api/v1/admin/documentation/media-capabilities')
          return json({
            enabled: true,
            types: [
              {
                contentType: 'application/pdf',
                kind: 'document',
                extension: 'pdf',
                maximumBytes: 25 * 1024 * 1024,
              },
            ],
            maximumPendingFiles: 40,
          });
        if (path === '/api/v1/documentation') return json({ data: state.guides, nextCursor: null });
        if (/^\/api\/v1\/documentation\/\d+\/assets\//.test(path))
          return route.fulfill({
            status: 200,
            contentType: 'application/pdf',
            body: Buffer.from('%PDF-fixture'),
          });
        if (/^\/api\/v1\/documentation\/\d+$/.test(path))
          return json(state.guides.find((guide) => guide.id === path.split('/').at(-1)));
        if (path === '/api/v1/admin/store-location-codes') return json({ data: ['ONE', 'TWO'] });
        if (path === '/api/v1/admin/general-settings') return json({ data: state.settings });
        if (path === '/api/v1/admin/stores/1/delivery-slots') return json({ data: state.slots });
        if (path === '/api/v1/admin/stores/1/ecommerce-settings')
          return json({
            id: '1',
            name: 'Fixture Store One',
            threshold: 2,
            active: true,
            version: 'e'.repeat(64),
            lockedUntil: null,
            editable: false,
          });
        if (path === '/api/v1/admin/countries')
          return json({ data: [{ id: '99', name: 'Fixture country' }] });
        if (path === '/api/v1/admin/stores' || path === '/api/v1/admin/stores/1') {
          const store = {
            id: '1',
            store_name: 'Fixture Store One',
            location_code: 'ONE',
            type: 'STORE',
            category: 'IN_HOUSE',
            latitude: '19.00',
            longitude: '72.00',
            email: 'fixture@example.test',
            address: 'Fixture address',
            alt_address: '',
            city_id: state.storeCityId,
            country_id: 99,
            phone: '9876543210',
            pincode: '123456',
            per_day_threshold: 0,
            per_hour_threshold: 0,
            gstin: '',
            short_name: 'Fixture',
            slack_group_url: state.storeSlackConfigured
              ? 'https://hooks.slack.com/services/T1/B1/fixture'
              : '',
            city_name: 'Fixture city',
            state_name: 'Fixture state',
            state_id: 0,
            is_active: true,
            store_image: 'fixture.png',
          };
          return json(
            path === '/api/v1/admin/stores/1' ? store : { data: [store], nextCursor: null },
          );
        }
        if (path === '/api/v1/admin/stores/1/detail')
          return json({
            id: '1',
            name: 'Fixture Store One',
            locationCode: 'ONE',
            phone: '9876543210',
            email: 'fixture@example.test',
            address: 'Fixture address',
            alternateAddress: '',
            city: 'Fixture city',
            state: 'Fixture state',
            pincode: '123456',
            type: 'STORE',
            category: 'IN_HOUSE',
            active: true,
            latitude: '19.00',
            longitude: '72.00',
            gstin: '',
            shortName: 'Fixture',
            franchise: null,
            publicUrl: 'https://thesouledstore.com/?store_id=1',
          });
        if (path === '/api/v1/admin/stores/1/qr')
          return route.fulfill({ status: 200, contentType: 'image/png', body: imageBytes });
        if (path === '/api/v1/admin/operators' && state.collectionMode && pageInput) {
          const values = Array.from({ length: 27 }, (_, index) => ({
            id: String(index + 4),
            firstName: 'Synthetic',
            lastName: 'Staff ' + String(index).padStart(2, '0'),
            email: '=synthetic' + index + '@example.test',
            phone: '9876543210',
            contactEmail: 'otp@example.test',
            role: 5,
            userType: 1,
            otpMethod: 1,
            mfa: false,
            active: pageInput!.active !== 'false',
            storeIds: ['1'],
            storeNames: ['Fixture Store One'],
          }));
          if (pageInput.direction === 'desc') values.reverse();
          const start =
              pageInput.after === '0'
                ? 0
                : z
                    .object({ offset: z.number().int() })
                    .parse(
                      JSON.parse(
                        Buffer.from(pageInput.after.slice(3), 'base64url').toString('utf8'),
                      ) as unknown,
                    ).offset,
            end = start + pageInput.limit;
          return json({
            data: values.slice(start, end),
            nextCursor:
              end < values.length
                ? 'c1.' + Buffer.from(JSON.stringify({ offset: end })).toString('base64url')
                : null,
          });
        }
        if (path === '/api/v1/admin/operators')
          return json({
            data: [
              {
                id: '4',
                firstName: 'Fixture',
                lastName: 'Staff',
                email: 'staff@example.test',
                phone: '9876543210',
                contactEmail: 'staff@example.test',
                role: 5,
                userType: 1,
                otpMethod: 1,
                mfa: false,
                active: true,
                storeIds: state.operatorStoreIds,
              },
            ],
            nextCursor: null,
          });
        if (path === '/api/v1/admin/resource-stores')
          return json({ data: [{ id: '1', name: 'Fixture Store One' }] });
        if (path === '/api/v1/admin/storages') return json({ data: [], nextCursor: null });
        if (path === '/api/v1/admin/stores/1/counters' || path === '/api/v1/admin/counters')
          return json({
            data: [
              {
                id: '1',
                store: '1',
                counter_name: 'C1',
                counter_type: 'IN_STORE',
                counter_desc: 'Fixture counter',
                is_active: true,
                storeName: 'Fixture Store One',
              },
            ],
            nextCursor: null,
          });
        if (path === '/api/v1/admin/stores/1/storages') return json({ data: [], nextCursor: null });
        if (path === '/api/v1/admin/stores/1/payment-terminals')
          return json({
            data: state.terminalExists
              ? [
                  {
                    id: '10',
                    counterId: 1,
                    name: 'Machine 1',
                    merchantName: 'Fixture merchant',
                    storeName: 'Fixture Store One',
                    terminalId: 'fixture-terminal',
                    active: state.terminalActive ? 1 : 0,
                    provider: 'paytm',
                  },
                ]
              : [],
          });
        if (path === '/api/v1/admin/stores/1/payment-terminals/paytm/10')
          return json({
            id: '10',
            provider: 'paytm',
            name: 'Machine 1',
            merchantId: 'fixture-merchant',
            terminalId: 'fixture-terminal',
            deviceSerialNumber: '9223372036854775807',
            active: state.terminalActive,
          });
        return json(
          {
            error: { code: 'FIXTURE_ROUTE_NOT_FOUND', message: 'Fixture resource is unavailable.' },
          },
          404,
        );
      });
      await page.route('https://upload.example.test/**', async (route) => {
        state.s3Posts++;
        state.s3Cookie = route.request().headers()['cookie'];
        return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': origin } });
      });
      await page.goto(
        applicationScreen
          ? `${origin}/application-links/${applicationScreen}#${applicationScreen === 'staff' ? 'A'.repeat(43) : '1.' + 'C'.repeat(43)}`
          : `${origin}/__administration-test__?screen=${screen}`,
      );
      return state;
    }

    it('restores active and archived collection paging, server sort, column visibility and the visible-page CSV', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      const state = await fixture(page);
      state.collectionMode = true;
      try {
        await page.getByRole('tab', { name: 'Operators', exact: true }).click();
        await browserExpect(
          page.getByRole('cell', { name: 'Synthetic Staff 00', exact: true }),
        ).toBeVisible();
        await page.getByLabel('Page size', { exact: true }).selectOption('10');
        await browserExpect(page.getByRole('row')).toHaveCount(11);
        await page.getByRole('button', { name: 'Next page', exact: true }).click();
        await browserExpect(
          page.getByRole('cell', { name: 'Synthetic Staff 10', exact: true }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Previous page', exact: true }).click();
        await browserExpect(
          page.getByRole('cell', { name: 'Synthetic Staff 00', exact: true }),
        ).toBeVisible();
        await page.getByLabel('Sort by', { exact: true }).selectOption('name');
        await page.getByLabel('Sort direction', { exact: true }).selectOption('desc');
        await browserExpect(
          page.getByRole('cell', { name: 'Synthetic Staff 26', exact: true }),
        ).toBeVisible();
        await page.getByLabel('Operators status', { exact: true }).selectOption('false');
        await browserExpect(page.getByRole('row').nth(1)).toContainText('Archived');
        await page.getByText('Columns', { exact: true }).click();
        await page.getByLabel('Phone', { exact: true }).uncheck();
        await browserExpect(
          page.getByRole('columnheader', { name: 'Phone', exact: true }),
        ).toHaveCount(0);
        const downloadEvent = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Export visible page CSV', exact: true }).click();
        const file = await downloadEvent,
          path = await file.path();
        if (!path) throw new Error('Synthetic CSV missing');
        const csv = readFileSync(path, 'utf8');
        expect(csv).not.toContain('"Phone"');
        expect(csv).toContain("'=synthetic26@example.test");
        // The rewrite-only "queue all matching CSV" export is deleted (no legacy job).
        await browserExpect(
          page.getByRole('button', { name: 'Queue all matching CSV', exact: true }),
        ).toHaveCount(0);
        expect(state.collectionSearches.some((value) => value.after.startsWith('c1.'))).toBe(true);
        expect(state.collectionSearches.at(-1)).toMatchObject({
          path: '/api/v1/admin/operators/search',
          limit: 10,
          sort: 'name',
          direction: 'desc',
          active: 'false',
        });
        expect(state.console.filter((value) => /synthetic\d+@/.test(value))).toEqual([]);
      } finally {
        await context.close();
      }
    }, 30000);
    it('opens a selected store read-only detail and downloads its static marketing QR without issuing an application capability', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      const state = await fixture(page);
      try {
        await page.getByRole('button', { name: 'View', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Store details', exact: true });
        await browserExpect(
          dialog.getByText('https://thesouledstore.com/?store_id=1', { exact: true }),
        ).toBeVisible();
        await browserExpect(dialog.getByText('Fixture address', { exact: true })).toBeVisible();
        const pending = page.waitForEvent('download');
        await dialog.getByRole('button', { name: 'Download store QR PNG', exact: true }).click();
        const file = await pending,
          path = await file.path();
        expect(file.suggestedFilename()).toBe('store-1-qr.png');
        if (!path) throw new Error('Synthetic PNG missing');
        expect(readFileSync(path)).toEqual(imageBytes);
        expect(state.applicationRequests).toEqual([]);
        await dialog.getByRole('button', { name: 'Close store details', exact: true }).click();
        await browserExpect(dialog).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
    it('edits scoped operator store access through the actual dialog and validated API client', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page.getByRole('tab', { name: 'Operators', exact: true }).click();
        const row = page.getByRole('row').filter({ hasText: 'Fixture Staff' });
        await row.getByRole('button', { name: 'Stores', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel(/Fixture Store One/).uncheck();
        await dialog.getByLabel(/Fixture Store Two/).check();
        await dialog.getByRole('button', { name: 'Save store access', exact: true }).click();
        await browserExpect(dialog).toHaveCount(0);
        expect(state.mutations).toEqual([
          { path: '/api/v1/admin/operators/4/stores', method: 'PUT', body: { storeIds: ['2'] } },
        ]);
        await browserExpect(page.getByRole('status')).toContainText(
          'Operator store access updated.',
        );
      } finally {
        await page.close();
      }
    }, 20000);

    it('edits long buffer durations and exact delivery times, then closes all slots using current versions', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page.getByRole('tab', { name: 'Settings & timings', exact: true }).click();
        const buffer = page
          .getByRole('row')
          .filter({ hasText: 'Order creation buffer (hours:minutes)' });
        await buffer.getByRole('button', { name: 'Edit', exact: true }).click();
        let dialog = page.getByRole('dialog');
        await dialog
          .getByLabel('Order creation buffer (hours:minutes)', { exact: true })
          .fill('72:15');
        await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
        await browserExpect(dialog).toHaveCount(0);
        expect(state.mutations[0]).toMatchObject({
          path: '/api/v1/admin/general-settings/order-creation-buffer',
          method: 'PUT',
          body: {
            value: '72:15',
            expectedVersion: 'b'.repeat(64),
            operationId: expect.any(String),
          },
        });
        await browserExpect(buffer).toContainText('72:15');
        const monday = page.getByRole('row').filter({ hasText: 'MON' });
        await monday.getByRole('button', { name: 'Edit', exact: true }).click();
        dialog = page.getByRole('dialog');
        await browserExpect(dialog.getByLabel('Opening time', { exact: true })).toHaveValue(
          '09:00:15',
        );
        await dialog.getByLabel('Opening time', { exact: true }).fill('10:30:15');
        await dialog.getByLabel('Day', { exact: true }).selectOption('WED');
        await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
        await browserExpect(dialog).toHaveCount(0);
        expect(state.mutations[1]).toMatchObject({
          method: 'PUT',
          path: '/api/v1/admin/stores/1/delivery-slots/30',
          body: {
            weekday: 'WED',
            start: '10:30:15',
            end: '22:00:00',
            expectedVersion: 'c'.repeat(64),
            destinationStoreId: '1',
            operationId: expect.any(String),
          },
        });
        await page.getByRole('button', { name: 'Close all slots', exact: true }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Open all slots', exact: true }),
        ).toBeVisible();
        expect(state.slots.every((slot) => slot.available === 0)).toBe(true);
        expect(state.mutations[2]).toMatchObject({
          method: 'PATCH',
          path: '/api/v1/admin/stores/1/delivery-slots/availability',
          body: {
            active: false,
            expectedSlots: state.slots.map(({ id, version }) => ({ id, version })),
            operationId: expect.any(String),
          },
        });
        await browserExpect(
          page.getByRole('button', { name: 'Edit e-commerce delivery', exact: true }),
        ).toBeDisabled();
        expect(state.console.join('\n')).not.toContain('private-canary');
      } finally {
        await page.close();
      }
    }, 20000);
    it('uploads an inventory CSV as the source view and shows failed records from history', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page.getByRole('tab', { name: 'Inventory imports', exact: true }).click();
        await page.getByLabel('Choose inventory CSV', { exact: true }).setInputFiles({
          name: 'Visibility.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(
            'SkuId,StoreId,IsHold,Hold/UnholdQty,IsAvailable,IsDelete\r\n1000,1,,,0,1\r\n',
          ),
        });
        await page.getByRole('button', { name: 'Upload CSV', exact: true }).click();
        await browserExpect(
          page.getByText('Csv Uploaded successfully. Data may take some time to reflect.', {
            exact: true,
          }),
        ).toBeVisible();
        expect(state.importUploads).toEqual([
          {
            type: 'PRODUCT_STOCK_CSV',
            name: 'Visibility.csv',
            csv: 'SkuId,StoreId,IsHold,Hold/UnholdQty,IsAvailable,IsDelete\r\n1000,1,,,0,1\r\n',
          },
        ]);
        const row = page.getByRole('row').filter({ hasText: 'Product Stock Data Updated' });
        await row.getByRole('button', { name: 'View records', exact: true }).click();
        await browserExpect(
          page.getByText('Error while traversing csv data.', { exact: true }),
        ).toBeVisible();
        expect(page.url()).toContain('/__administration-test__');
      } finally {
        await page.close();
      }
    }, 20000);
    it('creates an uploaded guide and reads/downloads it without external navigation or script execution', async () => {
      const page = await browser.newPage();
      let dialogs = 0;
      page.on('dialog', async (dialog) => {
        dialogs++;
        await dialog.dismiss();
      });
      try {
        await page
          .context()
          .addCookies([
            { name: 'private_canary', value: 'must-not-send', url: 'https://upload.example.test/' },
          ]);
        const state = await fixture(page, 'documentation');
        await page.getByRole('button', { name: 'Create guide', exact: true }).click();
        let dialog = page.getByRole('dialog');
        await dialog.getByLabel('Guide title', { exact: true }).fill('Uploaded fixture guide');
        await dialog.getByLabel('Guide short description', { exact: true }).fill('Fixture summary');
        await dialog.getByLabel('Guide description', { exact: true }).fill('Safe instructions.');
        await dialog.getByLabel('Guide display priority', { exact: true }).fill('5');
        await dialog.getByLabel('Upload documents', { exact: true }).setInputFiles({
          name: 'Fixture.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-fixture'),
        });
        await browserExpect(dialog.getByText('Fixture.pdf · Ready', { exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: 'Save guide', exact: true }).click();
        await browserExpect(dialog).toHaveCount(0);
        expect(state.s3Posts).toBe(1);
        expect(state.s3Cookie).toBeUndefined();
        expect(state.guideUploads[0]?.checksum).toBe(
          createHash('sha256').update('%PDF-fixture').digest('base64'),
        );
        const article = page.getByRole('row').filter({ hasText: 'Uploaded fixture guide' });
        await article.getByRole('button', { name: 'Read guide', exact: true }).click();
        dialog = page.getByRole('dialog');
        await browserExpect(dialog.locator('iframe')).toHaveAttribute('sandbox', '');
        const download = page.waitForEvent('download');
        await dialog.getByRole('button', { name: 'Download', exact: true }).click();
        const file = await download;
        expect(file.suggestedFilename()).toBe('Fixture.pdf');
        await file.delete();
        expect(dialogs).toBe(0);
        expect(page.url()).toContain('/__administration-test__');
        await dialog.getByRole('button', { name: 'Close guide', exact: true }).last().click();
        await browserExpect(dialog).toHaveCount(0);
      } finally {
        await page.close();
      }
    }, 20000);
    it('keeps operator contact search in a POST body and out of URLs and browser logs', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page.getByRole('tab', { name: 'Operators', exact: true }).click();
        await page
          .getByLabel('Find operators', { exact: true })
          .fill('private-search-canary@example.test');
        await browserExpect
          .poll(() => state.personSearches.at(-1)?.search)
          .toBe('private-search-canary@example.test');
        expect(state.personSearches.at(-1)?.path).toBe('/api/v1/admin/operators/search');
        expect(
          state.personSearches.every(
            (search) => !search.url.includes('private-search-canary') && !search.url.includes('?'),
          ),
        ).toBe(true);
        expect(page.url()).not.toContain('private-search-canary');
        expect(state.console.join('\n')).not.toContain('private-search-canary');
      } finally {
        await page.close();
      }
    }, 20000);
    it('uploads a synthetic profile image under exact-origin CSP and retries only attachment after a lost response', async () => {
      const page = await browser.newPage();
      try {
        await page
          .context()
          .addCookies([
            { name: 'private_canary', value: 'must-not-send', url: 'https://upload.example.test/' },
          ]);
        const state = await fixture(page, 'profile-images');
        const csp = (await page.request.get(`${origin}/__administration-test__`)).headers()[
          'content-security-policy'
        ]!;
        expect(csp).toContain(
          `connect-src 'self' ${origin.replace('http:', 'ws:')} https://upload.example.test;`,
        );
        expect(csp).not.toContain('*.');
        state.dropImageAttachmentResponse = true;
        await page.getByLabel('Change profile image', { exact: true }).setInputFiles({
          name: 'Private fixture.png',
          mimeType: 'image/png',
          buffer: imageBytes,
        });
        await browserExpect(
          page.getByRole('button', { name: 'Retry image attachment', exact: true }),
        ).toBeEnabled();
        expect(state.profileHasImage).toBe(true); // Server committed before its response was dropped.
        expect(state.s3Posts).toBe(1);
        expect(state.s3Cookie).toBeUndefined();
        expect(state.imageUploads[0]).toMatchObject({
          size: imageBytes.length,
          checksum: createHash('sha256').update(imageBytes).digest('base64'),
        });
        // Hold the post-attachment profile reload so the "saved, still reloading" state is
        // asserted deterministically instead of depending on how fast the reload is.
        let releaseReload: () => void = () => undefined,
          reloadRequested: () => void = () => undefined;
        const reloadGate = new Promise<void>((resolve) => {
            releaseReload = resolve;
          }),
          reloadStarted = new Promise<void>((resolve) => {
            reloadRequested = resolve;
          });
        await page.route(
          (url) => url.pathname === '/api/v1/operators/current/profile',
          async (route) => {
            reloadRequested();
            await reloadGate;
            await route.fallback();
          },
          { times: 1 },
        );
        try {
          await page.getByRole('button', { name: 'Retry image attachment', exact: true }).click();
          await reloadStarted;
          // Only the current attempt's state is announced: one status, the saved message.
          await browserExpect(page.getByRole('status')).toHaveCount(1);
          await browserExpect(page.getByRole('status')).toHaveText('Image saved.');
          await browserExpect(
            page.getByRole('button', { name: 'Retry image attachment', exact: true }),
          ).toHaveCount(0);
        } finally {
          releaseReload();
        }
        await browserExpect(page.getByLabel('Change profile image', { exact: true })).toBeEnabled();
        await browserExpect(page.getByRole('status')).toHaveText('Image saved.');
        const image = page.getByRole('img', { name: 'Profile image', exact: true });
        await browserExpect(image).toBeVisible();
        expect(
          await image.evaluate(
            (element) =>
              element instanceof HTMLImageElement && element.complete && element.naturalWidth === 4,
          ),
        ).toBe(true);
        expect(state.imageUploads).toHaveLength(1);
        expect(state.s3Posts).toBe(1);
        expect(state.imageAttachmentAttempts).toEqual([
          state.imageUploads[0]!.id,
          state.imageUploads[0]!.id,
        ]);
        await page
          .getByLabel('Change cover image', { exact: true })
          .setInputFiles({ name: 'Cover fixture.png', mimeType: 'image/png', buffer: imageBytes });
        await browserExpect(
          page.getByRole('img', { name: 'Cover image', exact: true }),
        ).toBeVisible();
        expect(state.imageUploads.at(-1)?.kind).toBe('cover-image');
        expect(state.s3Posts).toBe(2);
        // The cover attempt has finished its reload before the next file is chosen.
        await browserExpect(page.getByLabel('Change profile image', { exact: true })).toBeEnabled();
        await browserExpect(page.getByRole('status')).toHaveText('Image saved.');
        const uploadCount = state.imageUploads.length;
        await page.getByLabel('Change profile image', { exact: true }).setInputFiles({
          name: 'Unsafe.svg',
          mimeType: 'image/svg+xml',
          buffer: Buffer.from('<svg onload="alert(1)"></svg>'),
        });
        await browserExpect(page.getByRole('alert')).toContainText(
          'Choose a JPEG, PNG, WebP or GIF',
        );
        expect(state.imageUploads).toHaveLength(uploadCount);
        expect(state.console.join('\n')).not.toContain('Private fixture.png');
        const persisted = await page.evaluate(() =>
          JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
        );
        expect(persisted).not.toContain('Private fixture.png');
      } finally {
        await page.close();
      }
    }, 20000);
    it('verifies a local authenticator QR and keeps replacement secrets out of cached browser state', async () => {
      const page = await browser.newPage();
      const externalQrRequests: string[] = [];
      page.on('request', (request) => {
        if (/google|chart\.apis/i.test(request.url())) externalQrRequests.push(request.url());
      });
      try {
        const state = await fixture(page);
        await page.getByRole('tab', { name: 'Operators', exact: true }).click();
        await page.getByRole('button', { name: 'Authenticator', exact: true }).click();
        let dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
        await browserExpect(dialog.getByAltText('Private authenticator setup QR')).toHaveAttribute(
          'src',
          /^data:image\/png;base64,/,
        );
        await dialog.getByLabel('Authenticator code', { exact: true }).fill('111111');
        await dialog.getByRole('button', { name: 'Verify authenticator', exact: true }).click();
        // The legacy message, followed by the server request reference shown beside errors.
        await browserExpect(dialog.getByRole('alert')).toHaveText(
          /^Wrong OTP, Enter correct OTP(?:Reference [0-9a-f-]{36})?$/,
        );
        expect(state.mfaEnabled).toBe(false);
        await dialog.getByLabel('Authenticator code', { exact: true }).fill('123456');
        await dialog.getByRole('button', { name: 'Verify authenticator', exact: true }).click();
        await browserExpect(
          dialog.getByText('Authenticator is enabled.', { exact: true }),
        ).toBeVisible();
        await browserExpect(dialog.locator('img')).toHaveCount(0);
        await dialog.getByLabel('Authenticator action', { exact: true }).selectOption('replace');
        const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
        await browserExpect(
          dialog.getByLabel('New authenticator secret', { exact: true }),
        ).toHaveAttribute('type', 'password');
        await dialog.getByLabel('New authenticator secret', { exact: true }).fill(secret);
        await dialog.getByLabel('New authenticator code', { exact: true }).fill('123456');
        await dialog
          .getByRole('button', { name: 'Apply authenticator reset', exact: true })
          .click();
        await browserExpect(dialog.getByRole('status')).toHaveText('Authenticator replaced.');
        await browserExpect(
          dialog.getByLabel('New authenticator secret', { exact: true }),
        ).toHaveValue('');
        await dialog.getByRole('button', { name: 'Close authenticator', exact: true }).click();
        await page.getByRole('button', { name: 'Authenticator', exact: true }).click();
        dialog = page.getByRole('dialog');
        await browserExpect(dialog.getByLabel('Authenticator action', { exact: true })).toHaveValue(
          'disable',
        );
        await dialog
          .getByRole('button', { name: 'Apply authenticator reset', exact: true })
          .click();
        await browserExpect(
          dialog.getByText('Authenticator is disabled.', { exact: true }),
        ).toBeVisible();
        expect(state.mfaEnabled).toBe(false);
        expect(externalQrRequests).toEqual([]);
        const persisted = await page.evaluate(() =>
          JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
        );
        expect(persisted).not.toContain(secret);
        expect(state.console.join('\n')).not.toContain(secret);
      } finally {
        await page.close();
      }
    }, 20000);
    it('edits the full operator profile, resets a password and attaches a private image with captured actor binding', async () => {
      const page = await browser.newPage();
      const urls: string[] = [];
      page.on('request', (request) => urls.push(request.url()));
      try {
        const state = await fixture(page);
        await page.getByRole('tab', { name: 'Operators', exact: true }).click();
        await page.getByRole('button', { name: 'Full profile', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await browserExpect(dialog.getByLabel('Administrative date joined')).toHaveValue(
          '2000-01-01 12:13:14.123456',
        );
        await dialog.getByLabel('Administrative login name').fill('floor.canary.operator');
        await dialog.getByLabel('Administrative age').fill('42');
        await dialog.getByLabel('Administrative gender').selectOption('O');
        await dialog.getByLabel('Administrative last login').fill('2000-02-29 23:59:58.654321');
        await dialog
          .getByRole('button', { name: 'Save administrative profile', exact: true })
          .click();
        await browserExpect(dialog.getByRole('status')).toHaveText(
          'Operator administrative profile saved.',
        );
        expect(state.operatorProfile).toMatchObject({
          username: 'floor.canary.operator',
          age: 42,
          gender: 'O',
          lastLogin: '2000-02-29 23:59:58.654321',
          dateJoined: '2000-01-01 12:13:14.123456',
        });
        const password = 'Riv3r!Cobalt-Forest#89';
        await dialog.getByLabel('Administrative new password').fill(password);
        await dialog.getByLabel('Administrative confirm password').fill(password);
        await dialog.getByRole('button', { name: 'Reset password', exact: true }).click();
        await browserExpect(dialog.getByRole('status')).toHaveText(
          'Operator password reset. Existing authentication was revoked.',
        );
        await browserExpect(dialog.getByLabel('Administrative new password')).toHaveValue('');
        state.dropImageAttachmentResponse = true;
        await dialog
          .getByLabel('Change operator profile image')
          .setInputFiles(new URL('./fixtures/private-image.png', import.meta.url).pathname);
        await browserExpect(
          dialog.getByRole('button', { name: 'Retry image attachment', exact: true }),
        ).toBeEnabled();
        await dialog.getByRole('button', { name: 'Retry image attachment', exact: true }).click();
        await browserExpect(dialog.getByAltText('Operator profile image')).toBeVisible();
        expect(state.imageUploads).toHaveLength(1);
        expect(state.imageUploads[0]?.scope).toBe('managed');
        expect(state.s3Posts).toBe(1);
        expect(state.s3Cookie).toBeUndefined();
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
          window.dispatchEvent(new Event('offline'));
        });
        await browserExpect(
          dialog.getByRole('button', { name: 'Save administrative profile', exact: true }),
        ).toBeDisabled();
        const persisted = await page.evaluate(() =>
          JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
        );
        expect(persisted).not.toContain(password);
        expect(urls.join('\n')).not.toMatch(/floor\.canary\.operator|Riv3r|Cobalt|9876543204/);
        expect(state.console.join('\n')).not.toMatch(/floor\.canary\.operator|Riv3r|Cobalt/);
      } finally {
        await page.close();
      }
    }, 20000);
    it('keeps a paused image continuation bound to its original operator after the global identity changes', async () => {
      const page = await browser.newPage();
      let release: () => void = () => undefined,
        started: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        upload = new Promise<void>((resolve) => {
          started = resolve;
        });
      try {
        const state = await fixture(page, 'profile-images');
        await page.route('https://upload.example.test/**', async (route) => {
          started();
          await gate;
          await route
            .fulfill({
              status: 204,
              headers: { 'Access-Control-Allow-Origin': origin },
              body: '',
            })
            .catch(() => undefined);
        });
        await page
          .getByLabel('Change profile image')
          .setInputFiles(new URL('./fixtures/private-image.png', import.meta.url).pathname);
        await upload;
        state.expectedRequestActor = '2';
        await page.evaluate(
          "import('/src/api/client.ts').then(api => api.setRequestOperator('2'))",
        );
        release();
        await browserExpect(page.getByRole('alert')).toContainText(
          'The signed-in operator changed.',
        );
        expect(state.deniedActors).toEqual([]);
        expect(state.imageAttachmentAttempts).toEqual([]);
        expect(state.profileHasImage).toBe(false);
      } finally {
        release();
        await page.close();
      }
    }, 20000);
    it('filters permission activity in request bodies, pages exact IDs and exports the visible loaded page safely', async () => {
      const page = await browser.newPage(),
        urls: string[] = [];
      page.on('request', (request) => urls.push(request.url()));
      try {
        const state = await fixture(page, 'permission-history');
        await browserExpect(page.getByRole('status')).toHaveText('13 matching activities.');
        await browserExpect(page.getByRole('row')).toHaveCount(11);
        const loaded = state.activitySearches.length;
        await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
        await browserExpect.poll(() => state.activitySearches.length).toBe(loaded + 1);
        await page.getByRole('button', { name: 'Next activity page', exact: true }).click();
        await browserExpect(page.getByRole('row')).toHaveCount(4);
        expect(state.activitySearches.at(-1)?.input.start).toBe(10);
        await page.getByLabel('Activity rows per page', { exact: true }).selectOption('500');
        await browserExpect(page.getByRole('row')).toHaveCount(14);
        await page.getByText('Activity columns', { exact: true }).click();
        await page.getByLabel('Created at', { exact: true }).uncheck();
        const ready = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Export visible page CSV', exact: true }).click();
        const download = await ready,
          path = await download.path();
        expect(download.suggestedFilename()).toBe('permission-activity.csv');
        expect(path).not.toBeNull();
        const csv = readFileSync(path!, 'utf8');
        expect(csv).toContain('"\'=SUM(1,2)"');
        expect(csv).toContain('"NA"," ",');
        expect(csv).toContain('"unknown"');
        expect(csv).not.toContain('Created at');
        expect(csv).not.toContain('2026-11-16T12:00:00');
        expect(csv.split('\r\n')).toHaveLength(14);
        await page
          .getByLabel('Find permission activity', { exact: true })
          .fill('customer.fixture@example.test');
        await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
        await browserExpect(page.getByRole('status')).toHaveText('1 matching activities.');
        await browserExpect(page.getByRole('row')).toHaveCount(2);
        expect(state.activitySearches.at(-1)?.input.search).toBe('customer.fixture@example.test');
        await page.getByRole('button', { name: 'Today', exact: true }).click();
        await browserExpect(page.getByLabel('Activity from date', { exact: true })).toHaveValue(
          '2026-11-16',
        );
        expect(state.activitySearches.at(-1)?.input).toMatchObject({
          from: '2026-11-16',
          to: '2026-11-16',
          length: 500,
        });
        expect(urls.join('\n')).not.toContain('customer.fixture@example.test');
        expect(state.console.join('\n')).not.toContain('customer.fixture@example.test');
        expect(state.mutations).toHaveLength(0);
        await page.reload();
        await browserExpect(page.getByLabel('Activity rows per page', { exact: true })).toHaveValue(
          '500',
        );
        await browserExpect(
          page.getByRole('columnheader', { name: 'Created at', exact: true }),
        ).toHaveCount(0);
        await browserExpect(
          page.getByLabel('Find permission activity', { exact: true }),
        ).toHaveValue('');
        const storage = await page.evaluate(() => JSON.stringify(localStorage));
        expect(storage).not.toContain('customer.fixture@example.test');
      } finally {
        await page.close();
      }
    }, 20000);
    it('keeps unavailable all-history reads explicit, recovers through today and disables filtering while offline', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page, 'permission-history');
        await browserExpect(page.getByRole('status')).toHaveText('13 matching activities.');
        await page.getByRole('button', { name: 'Today', exact: true }).click();
        await browserExpect(page.getByRole('status')).toHaveText('13 matching activities.');
        state.activityUnavailable = true;
        await page.getByRole('button', { name: 'All history', exact: true }).click();
        await browserExpect(page.getByRole('alert')).toContainText(
          'Historical activity is temporarily unavailable',
        );
        const failedCount = state.activitySearches.length;
        await page.getByRole('button', { name: 'Today', exact: true }).click();
        await browserExpect(page.getByRole('status')).toHaveText('13 matching activities.');
        expect(
          state.activitySearches
            .slice(failedCount)
            .every((call) => call.input.from === '2026-11-16' && call.input.to === '2026-11-16'),
        ).toBe(true);
        await page.context().setOffline(true);
        await page.evaluate(() => window.dispatchEvent(new Event('offline')));
        await browserExpect(
          page.getByRole('button', { name: 'Apply filters', exact: true }),
        ).toBeDisabled();
        await browserExpect(
          page.getByText('Reconnect to load activity history.', { exact: true }),
        ).toBeVisible();
        expect(state.mutations).toHaveLength(0);
      } finally {
        await page.context().setOffline(false);
        await page.close();
      }
    }, 20000);
    it('generates application handoff QR images, downloads the approved installer and revokes the staff proof', async () => {
      const page = await browser.newPage(),
        urls: string[] = [];
      page.on('request', (request) => urls.push(request.url()));
      try {
        await page
          .context()
          .addCookies([
            { name: 'pos_session', value: 'fixture-session-cookie', url: origin, httpOnly: true },
          ]);
        const state = await fixture(page, 'application-links');
        await page.getByRole('button', { name: 'Generate staff QR', exact: true }).click();
        await browserExpect(page.getByAltText('Staff installer QR code')).toBeVisible();
        await browserExpect(page.getByRole('status')).toContainText('Expires in');
        await page.getByRole('button', { name: 'Generate customer QR', exact: true }).click();
        await browserExpect(
          page.getByText('Fixture checked-in store', { exact: true }),
        ).toBeVisible();
        const pngReady = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download customer QR', exact: true }).click();
        const png = await pngReady;
        expect(png.suggestedFilename()).toBe('customer-application-qr.png');
        expect(readFileSync((await png.path())!)).toEqual(imageBytes);
        const apkReady = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download staff installer', exact: true }).click();
        const apk = await apkReady;
        expect(apk.suggestedFilename()).toBe('mpos.apk');
        expect(readFileSync((await apk.path())!)).toEqual(Buffer.from([80, 75, 3, 4]));
        expect(
          state.applicationRequests
            .filter((call) => call.path.startsWith('/api/v1/auth/'))
            .every((call) => call.cookie === undefined),
        ).toBe(true);
        expect(
          state.applicationRequests.some(
            (call) =>
              call.path.startsWith('/api/v1/operators/') &&
              call.cookie?.includes('fixture-session-cookie'),
          ),
        ).toBe(true);
        expect(urls.join('\n')).not.toMatch(/A{43}|B{43}|C{43}|fixture-session-cookie/);
        expect(state.console.join('\n')).not.toMatch(/A{43}|B{43}|C{43}|fixture-session-cookie/);
        expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toMatch(
          /A{43}|B{43}|C{43}/,
        );
      } finally {
        await page.close();
      }
    }, 20000);
    it('redeems a staff application fragment without cookies and retries a dropped package response with the same proof operation', async () => {
      const page = await browser.newPage(),
        urls: string[] = [];
      page.on('request', (request) => urls.push(request.url()));
      try {
        await page
          .context()
          .addCookies([
            { name: 'pos_session', value: 'fixture-session-cookie', url: origin, httpOnly: true },
          ]);
        const state = await fixture(page, 'administration', 'staff');
        await browserExpect(
          page.getByRole('heading', { name: 'Staff application download', exact: true }),
        ).toBeVisible();
        expect(new URL(page.url()).hash).toBe('');
        expect(state.applicationRequests).toHaveLength(0);
        state.applicationBinaryFailures = 1;
        await page.getByRole('button', { name: 'Download staff installer', exact: true }).click();
        await browserExpect(page.getByRole('alert')).toContainText(
          'Could not open the application link. Try again.',
        );
        const ready = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download staff installer', exact: true }).click();
        expect((await ready).suggestedFilename()).toBe('mpos.apk');
        await browserExpect(page.getByRole('status')).toHaveText('The download has started.');
        const activation = state.applicationRequests.filter((call) =>
            call.path.endsWith('/staff-download-activations'),
          ),
          content = state.applicationRequests.filter((call) =>
            call.path.endsWith('/staff-download-content'),
          );
        expect(activation).toHaveLength(1);
        expect(content).toHaveLength(2);
        expect(content[0]?.body).toEqual(content[1]?.body);
        state.applicationActivationOperation = '';
        state.applicationDownloadOperation = '';
        await page.evaluate(() => {
          window.location.hash = 'D'.repeat(43);
        });
        await browserExpect(
          page.getByRole('button', { name: 'Download staff installer', exact: true }),
        ).toBeVisible();
        const nextDownload = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download staff installer', exact: true }).click();
        await nextDownload;
        expect(
          state.applicationRequests
            .filter((call) => call.path.endsWith('/staff-download-activations'))
            .at(-1)?.body,
        ).toMatchObject({ token: 'D'.repeat(43) });
        expect(new URL(page.url()).hash).toBe('');
        expect(state.applicationRequests.every((call) => call.cookie === undefined)).toBe(true);
        expect(urls.join('\n')).not.toMatch(/A{43}|B{43}|fixture-session-cookie/);
        expect(state.console.join('\n')).not.toMatch(/A{43}|B{43}|fixture-session-cookie/);
      } finally {
        await page.close();
      }
    }, 20000);
    it('redeems a customer application fragment through a body-only scan before following its approved destination', async () => {
      const page = await browser.newPage(),
        urls: string[] = [];
      page.on('request', (request) => urls.push(request.url()));
      try {
        await page.route('https://www.thesouledstore.com/app/fixture-customer', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<h1>Customer application fixture</h1>',
          }),
        );
        const state = await fixture(page, 'administration', 'customer');
        await browserExpect(
          page.getByRole('heading', { name: 'Open the customer application', exact: true }),
        ).toBeVisible();
        expect(new URL(page.url()).hash).toBe('');
        expect(state.applicationRequests).toHaveLength(0);
        await page.getByRole('button', { name: 'Open customer app', exact: true }).click();
        await browserExpect(
          page.getByRole('heading', { name: 'Customer application fixture', exact: true }),
        ).toBeVisible();
        expect(state.applicationRequests).toHaveLength(1);
        expect(state.applicationRequests[0]?.path).toBe(
          '/api/v1/auth/application-links/customer-scans',
        );
        expect(state.applicationRequests[0]?.cookie).toBeUndefined();
        // Customer fragments carry the store id (Redis application-link contract).
        expect(state.applicationRequests[0]?.body).toMatchObject({ token: '1.' + 'C'.repeat(43) });
        expect(urls.join('\n')).not.toContain('C'.repeat(43));
        expect(state.console.join('\n')).not.toContain('C'.repeat(43));
      } finally {
        await page.close();
      }
    }, 20000);
    it('exports terminal visible columns across bounded pages and refuses a changed full result', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.terminalTotal = 503;
        await page.getByRole('tab', { name: 'Counters & storage', exact: true }).click();
        const results = page
          .locator('section.catalog-results')
          .filter({ hasText: 'matching terminals' });
        await browserExpect(results).toContainText('503 matching terminals');
        await results.getByText('Columns', { exact: true }).click();
        await results.getByLabel('IMEI', { exact: true }).uncheck();
        let ready = page.waitForEvent('download');
        await results.getByRole('button', { name: 'Export visible rows CSV', exact: true }).click();
        let download = await ready;
        let path = await download.path();
        if (!path) throw new Error('Local download unavailable');
        let csv = readFileSync(path, 'utf8');
        expect(csv.trim().split('\r\n')).toHaveLength(26);
        expect(csv.split('\r\n')[0]).not.toContain('IMEI');
        expect(csv).toContain("'=Fixture merchant");
        expect(csv).toContain('9223372036854775807');
        await download.delete();
        ready = page.waitForEvent('download');
        await results.getByRole('button', { name: 'Export all matching CSV', exact: true }).click();
        download = await ready;
        path = await download.path();
        if (!path) throw new Error('Local download unavailable');
        csv = readFileSync(path, 'utf8');
        expect(csv.trim().split('\r\n')).toHaveLength(504);
        expect(csv.split('\r\n')[0]).not.toContain('IMEI');
        expect(
          state.terminalSearches
            .filter((input) => input.length === 500)
            .map((input) => input.start),
        ).toEqual([0, 500]);
        await download.delete();
        state.terminalChangedCount = true;
        let unexpected = false;
        page.on('download', () => {
          unexpected = true;
        });
        await results.getByRole('button', { name: 'Export all matching CSV', exact: true }).click();
        await browserExpect(
          page.getByText('The terminal directory changed. Refresh and export again.', {
            exact: true,
          }),
        ).toBeVisible();
        expect(unexpected).toBe(false);
        expect(state.console.join('\n')).not.toContain('9223372036854775807');
      } finally {
        await page.close();
      }
    }, 30000);
    it('keeps terminal credentials blank, preserves bigint serials and confirms deletion', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page.getByRole('tab', { name: 'Counters & storage', exact: true }).click();
        let row = page.getByRole('row').filter({ hasText: 'Machine 1' });
        await row.getByRole('button', { name: 'Edit', exact: true }).click();
        let dialog = page.getByRole('dialog');
        await browserExpect(
          dialog.getByLabel('New merchant key (leave empty to keep)', { exact: true }),
        ).toHaveValue('');
        await browserExpect(dialog.getByLabel('Device serial number', { exact: true })).toHaveValue(
          '9223372036854775807',
        );
        await dialog.getByLabel('Status', { exact: true }).selectOption('false');
        await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
        await browserExpect(dialog).toHaveCount(0);
        expect(state.mutations[0]).toMatchObject({
          method: 'PUT',
          body: { provider: 'paytm', deviceSerialNumber: '9223372036854775807', active: false },
        });
        expect(state.mutations[0]?.body).not.toHaveProperty('merchantKey');
        row = page.getByRole('row').filter({ hasText: 'Machine 1' });
        await row.getByRole('button', { name: 'Delete', exact: true }).click();
        dialog = page.getByRole('dialog');
        await browserExpect(dialog).toContainText('Delete Paytm Machine 1?');
        expect(state.terminalExists).toBe(true);
        await dialog.getByRole('button', { name: 'Delete terminal', exact: true }).click();
        await browserExpect(dialog).toHaveCount(0);
        expect(state.terminalExists).toBe(false);
        await browserExpect(page.getByText('0 matching terminals', { exact: true })).toBeVisible();
        expect(state.console.join('\n')).not.toContain('merchant_key');
      } finally {
        await page.close();
      }
    }, 20000);
  },
);
