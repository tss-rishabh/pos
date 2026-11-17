import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Databases } from '../db/pools.js';
import type { Principal } from '../domain/access.js';
import { identifier } from '../domain/validation.js';
import { AppError } from '../domain/errors.js';
import { currentRequestTrace } from '../observability/context.js';
import { seal, unseal } from './crypto.js';
import { desktopSsoFlows } from './desktop-sso-schema.js';
import { googleSsoConfigured } from './google-sso.js';
import type { IdentityService, PasswordIdentity } from './identity.js';
import type { SessionCredential, SessionService, SessionTransaction } from './sessions.js';
import { operatorSessions } from './session-schema.js';

export const desktopSsoSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const desktopSsoClientProof = z
  .object({
    purpose: z.literal('desktop-sso-client'),
    id: z.uuid(),
    secret: desktopSsoSecret,
    expires: z.number().int().positive(),
  })
  .strict();
export const desktopSsoApproval = z
  .object({
    purpose: z.literal('desktop-sso-approval'),
    id: z.uuid(),
    secret: desktopSsoSecret,
    expires: z.number().int().positive(),
  })
  .strict();
const storedCredential = z
  .object({
    purpose: z.literal('desktop-sso-consumption'),
    id: z.uuid(),
    operatorId: identifier,
    credential: z
      .object({
        sessionId: z.uuid(),
        secret: desktopSsoSecret,
        expires: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
const flowStatus = z.enum([
  'pending',
  'awaiting-approval',
  'authorized',
  'consumed',
  'cancelled',
  'locked',
]);
type Flow = typeof desktopSsoFlows.$inferSelect;
type Approval = z.infer<typeof desktopSsoApproval>;
export function desktopSsoConfigured(config: Config): boolean {
  return (
    !config.DEMO_MODE &&
    config.DESKTOP_SSO_ENABLED &&
    Boolean(config.MYSQL_WRITER_URL) &&
    googleSsoConfigured(config)
  );
}
function unavailable() {
  return new AppError(503, 'DESKTOP_SSO_UNAVAILABLE', 'Desktop Google sign-in is unavailable.');
}
function missing() {
  return new AppError(404, 'DESKTOP_SSO_NOT_FOUND', 'This desktop sign-in could not be verified.');
}
function expired() {
  return new AppError(410, 'DESKTOP_SSO_EXPIRED', 'Start a new desktop sign-in.');
}

export async function pruneDesktopSsoFlows(db: Databases, now = Date.now(), limit = 500) {
  z.number().int().positive().max(500).parse(limit);
  return db
    .get('writer')
    .delete(desktopSsoFlows)
    .where(lt(desktopSsoFlows.expiresAt, now))
    .limit(limit);
}
export function desktopSsoService(
  config: Config,
  db: Databases,
  identity: IdentityService,
  sessions: SessionService,
  clock: () => number = Date.now,
) {
  function assertAvailable() {
    if (!desktopSsoConfigured(config) || !sessions.createInTransaction) throw unavailable();
  }
  function digest(purpose: string, id: string, secret: string) {
    return createHmac('sha256', config.SESSION_SECRET)
      .update(JSON.stringify([purpose, id, secret]))
      .digest('hex');
  }
  function matches(value: string | null, expected: string) {
    return (
      value !== null &&
      /^[a-f0-9]{64}$/.test(value) &&
      timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'))
    );
  }
  function validate(row: Flow | undefined): Flow {
    if (!row) throw missing();
    if (row.expiresAt <= clock()) throw expired();
    if (
      !flowStatus.safeParse(row.status).success ||
      !Number.isSafeInteger(row.expiresAt) ||
      !Number.isInteger(row.approvalAttempts) ||
      row.approvalAttempts < 0 ||
      row.approvalAttempts > 5
    )
      throw new AppError(
        503,
        'DESKTOP_SSO_PROOF_INVALID',
        'This sign-in requires a new authorization.',
      );
    return row;
  }
  async function locked(
    tx: SessionTransaction,
    id: string,
    proof?: { purpose: 'desktop' | 'browser' | 'approval'; value: string },
  ) {
    z.uuid().parse(id);
    if (proof) desktopSsoSecret.parse(proof.value);
    const [row] = await tx
      .select()
      .from(desktopSsoFlows)
      .where(eq(desktopSsoFlows.id, id))
      .limit(1)
      .for('update');
    if (!row) throw missing();
    if (proof) {
      const stored =
        proof.purpose === 'desktop'
          ? row.desktopSecretHash
          : proof.purpose === 'browser'
            ? row.browserTicketHash
            : row.approvalSecretHash;
      if (!matches(stored, digest(proof.purpose, id, proof.value))) throw missing();
    }
    return validate(row);
  }
  async function currentAccount(
    row: Flow,
    tx: SessionTransaction,
    lock: 'share' | 'update' = 'share',
  ): Promise<PasswordIdentity> {
    if (!row.operatorId || !row.authVersion) throw missing();
    const account = await identity.challengeIdentity(row.operatorId, tx, lock);
    if (!account || account.authVersion !== row.authVersion)
      throw new AppError(
        401,
        'DESKTOP_SSO_ACCOUNT_CHANGED',
        'Your POS access changed. Start sign-in again.',
      );
    return account;
  }
  function recoveredCredential(row: Flow): SessionCredential {
    try {
      const value = storedCredential.parse(
        unseal(row.consumedCredential ?? '', config.SESSION_SECRET),
      );
      if (value.id !== row.id || value.operatorId !== row.operatorId) throw missing();
      return value.credential;
    } catch {
      throw new AppError(
        503,
        'DESKTOP_SSO_PROOF_INVALID',
        'This sign-in requires a new authorization.',
      );
    }
  }
  async function browserRow(tx: SessionTransaction, raw: Approval) {
    const proof = desktopSsoApproval.parse(raw);
    if (proof.expires <= clock()) throw expired();
    return locked(tx, proof.id, { purpose: 'approval', value: proof.secret });
  }
  return {
    available: desktopSsoConfigured(config) && Boolean(sessions.createInTransaction),
    async create() {
      assertAvailable();
      const id = randomUUID(),
        secret = randomBytes(32).toString('base64url'),
        ticket = randomBytes(32).toString('base64url');
      const code = String(randomInt(1000000)).padStart(6, '0'),
        now = clock(),
        expires = now + 600000;
      await db
        .get('writer')
        .insert(desktopSsoFlows)
        .values({
          id,
          status: 'pending',
          desktopSecretHash: digest('desktop', id, secret),
          browserTicketHash: digest('browser', id, ticket),
          pairingCodeHash: digest('pairing-code', id, code),
          approvalAttempts: 0,
          createdAt: now,
          expiresAt: expires,
          requestId: currentRequestTrace()?.requestId ?? null,
        });
      return { id, secret, ticket, code, expires };
    },
    async start(id: string, ticket: string) {
      assertAvailable();
      return db.get('writer').transaction(async (tx) => {
        const row = await locked(tx, id, { purpose: 'browser', value: ticket });
        if (row.status !== 'pending' || row.startedAt !== null) throw expired();
        await tx
          .update(desktopSsoFlows)
          .set({ startedAt: clock() })
          .where(eq(desktopSsoFlows.id, id));
        return { id, expires: row.expiresAt };
      });
    },
    async bindIdentity(id: string, account: PasswordIdentity): Promise<Approval> {
      assertAvailable();
      return db.get('writer').transaction(async (tx) => {
        const row = await locked(tx, id);
        if (row.status !== 'pending' || row.startedAt === null) throw expired();
        const current = await identity.challengeIdentity(account.user.id, tx);
        if (!current || current.authVersion !== account.authVersion) throw expired();
        const secret = randomBytes(32).toString('base64url');
        await tx
          .update(desktopSsoFlows)
          .set({
            status: 'awaiting-approval',
            operatorId: account.user.id,
            authVersion: account.authVersion,
            approvalSecretHash: digest('approval', id, secret),
          })
          .where(eq(desktopSsoFlows.id, id));
        return { purpose: 'desktop-sso-approval', id, secret, expires: row.expiresAt };
      });
    },
    async approval(
      raw: Approval,
    ): Promise<{ user: Principal; expires: number; approved: boolean }> {
      assertAvailable();
      return db.get('writer').transaction(async (tx) => {
        const row = await browserRow(tx, raw);
        if (!['awaiting-approval', 'authorized', 'consumed'].includes(row.status)) throw expired();
        return {
          user: (await currentAccount(row, tx)).user,
          expires: row.expiresAt,
          approved: row.status !== 'awaiting-approval',
        };
      });
    },
    async approve(raw: Approval, code: string) {
      assertAvailable();
      z.string()
        .regex(/^\d{6}$/)
        .parse(code);
      const result = await db.get('writer').transaction(async (tx) => {
        const row = await browserRow(tx, raw);
        if (!['awaiting-approval', 'authorized', 'consumed'].includes(row.status)) throw expired();
        const account = await currentAccount(row, tx);
        if (row.status !== 'awaiting-approval')
          return { status: 'approved' as const, user: account.user };
        if (!matches(row.pairingCodeHash, digest('pairing-code', row.id, code))) {
          const attempts = row.approvalAttempts + 1;
          await tx
            .update(desktopSsoFlows)
            .set({ approvalAttempts: attempts, status: attempts >= 5 ? 'locked' : row.status })
            .where(eq(desktopSsoFlows.id, row.id));
          return { status: 'rejected' as const, locked: attempts >= 5 };
        }
        await tx
          .update(desktopSsoFlows)
          .set({ status: 'authorized', approvedAt: clock() })
          .where(eq(desktopSsoFlows.id, row.id));
        return { status: 'approved' as const, user: account.user };
      });
      if (result.status === 'rejected')
        throw new AppError(
          result.locked ? 403 : 400,
          result.locked ? 'DESKTOP_SSO_LOCKED' : 'DESKTOP_SSO_CODE_INVALID',
          result.locked
            ? 'Start a new desktop sign-in.'
            : 'Enter the code shown in the POS desktop app.',
        );
      return result;
    },
    async status(id: string, secret: string) {
      assertAvailable();
      return db.get('writer').transaction(async (tx) => {
        const row = await locked(tx, id, { purpose: 'desktop', value: secret });
        return { status: flowStatus.parse(row.status), expires: row.expiresAt };
      });
    },
    async consume(
      id: string,
      secret: string,
    ): Promise<{ user: Principal; credential: SessionCredential }> {
      assertAvailable();
      return db.get('writer').transaction(async (tx) => {
        const row = await locked(tx, id, { purpose: 'desktop', value: secret });
        if (!['authorized', 'consumed'].includes(row.status))
          throw new AppError(
            409,
            'DESKTOP_SSO_NOT_APPROVED',
            'Complete sign-in in your system browser first.',
          );
        const account = await currentAccount(row, tx, 'update');
        if (row.status === 'consumed') {
          const credential = recoveredCredential(row);
          if (!(await sessions.valid(account.user.id, credential, tx))) throw expired();
          return { user: account.user, credential };
        }
        const local = Temporal.Instant.fromEpochMilliseconds(clock()).toZonedDateTimeISO(
          config.BUSINESS_TIMEZONE,
        );
        const expires = local
          .startOfDay()
          .add({ days: 1 })
          .subtract({ seconds: 1 }).epochMilliseconds;
        if (expires <= clock()) throw expired();
        const credential = await sessions.createInTransaction!(
          tx,
          account.user.id,
          expires,
          account.authVersion,
          local.toPlainDateTime().toString({ smallestUnit: 'second' }).replace('T', ' '),
        );
        await tx
          .update(desktopSsoFlows)
          .set({
            status: 'consumed',
            consumedAt: clock(),
            consumedCredential: seal(
              {
                purpose: 'desktop-sso-consumption',
                id: row.id,
                operatorId: account.user.id,
                credential,
              },
              config.SESSION_SECRET,
            ),
          })
          .where(eq(desktopSsoFlows.id, row.id));
        return { user: account.user, credential };
      });
    },
    async cancel(id: string, secret: string) {
      // Retained client proofs must remain cancellable when new SSO is disabled.
      if (config.DEMO_MODE) throw unavailable();
      return db.get('writer').transaction(async (tx) => {
        const row = await locked(tx, id, { purpose: 'desktop', value: secret });
        if (row.status === 'consumed') {
          const credential = recoveredCredential(row);
          await tx
            .update(operatorSessions)
            .set({ revokedAt: new Date(clock()) })
            .where(
              and(
                eq(operatorSessions.id, credential.sessionId),
                eq(operatorSessions.userId, row.operatorId!),
              ),
            );
        }
        await tx
          .update(desktopSsoFlows)
          .set({ status: 'cancelled', consumedCredential: null, approvalSecretHash: null })
          .where(eq(desktopSsoFlows.id, row.id));
        return { cancelled: true as const };
      });
    },
  };
}
export type DesktopSsoService = ReturnType<typeof desktopSsoService>;
