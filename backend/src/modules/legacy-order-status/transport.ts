import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Config } from '../../config.js';
import { boundedJson } from '../../domain/http-json.js';
import {
  sourceStatusBody,
  verifiedReceipt,
  unknownStatusOutcome,
  wholeOrderStatusContract,
  statusCapabilitySchema,
  statusCapabilitySignature,
  type StatusReceipt,
} from './domain.js';
import { qualifiedStatusEndpoint, type WholeOrderStatusOptions } from './options.js';
import { wholeOrderStatusCommands } from './schema.js';
import { AppError } from '../../domain/errors.js';
export type StatusCommand = typeof wholeOrderStatusCommands.$inferSelect;
export interface WholeOrderStatusTransport {
  configured(): void;
  send(command: StatusCommand): Promise<StatusReceipt>;
  read(command: StatusCommand): Promise<StatusReceipt | null>;
}
export function wholeOrderStatusTransport(
  config: Config,
  options: WholeOrderStatusOptions,
  fetcher: typeof fetch = fetch,
): WholeOrderStatusTransport {
  const configured = () => {
    qualifiedStatusEndpoint(config, options);
  };
  function headers(command: StatusCommand) {
    const scope = Buffer.from(
      JSON.stringify({
        contract: wholeOrderStatusContract,
        operationId: command.id,
        operatorId: command.operatorId,
        authVersion: command.authVersion,
        storeId: command.storeId,
        counterId: command.snapshot.counterId,
        scopeHash: command.scopeHash,
        requestHash: command.requestHash,
        requestId: command.requestId,
      }),
    ).toString('base64url');
    return {
      'Content-Type': 'application/json',
      'x-api-key': options.BACKEND_SYNC_REPO_API_KEY!,
      'Idempotency-Key': command.id,
      'x-pos-status-scope': scope,
      'x-pos-status-proof': createHmac('sha256', options.WHOLE_ORDER_STATUS_RECEIPT_KEY!)
        .update('pos-whole-order-status-request-v1\0' + scope)
        .digest('base64url'),
    };
  }
  async function request(command: StatusCommand, read: boolean) {
    const base = qualifiedStatusEndpoint(config, options),
      url = new URL(
        read ? 'store-order/status/commands/' + command.id : 'store-order/status',
        base,
      );
    if (!read) {
      // A harmless authenticated challenge must qualify the receiving worker BEFORE
      // an old source endpoint could enqueue an unguarded vendor side effect.
      const challenge = randomUUID();
      try {
        const capability = await fetcher(new URL('store-order/status/capabilities', base), {
          method: 'GET',
          headers: { ...headers(command), 'x-pos-status-challenge': challenge },
          redirect: 'error',
          signal: AbortSignal.timeout(options.WHOLE_ORDER_STATUS_HTTP_TIMEOUT_MS),
        });
        if (!capability.ok) {
          await capability.body?.cancel();
          throw new Error('unqualified');
        }
        const value = statusCapabilitySchema.parse(await boundedJson(capability, 8192)),
          signature = capability.headers.get('x-pos-status-capability'),
          expected = statusCapabilitySignature(options.WHOLE_ORDER_STATUS_RECEIPT_KEY!, value);
        if (
          value.operationId !== command.id ||
          value.scopeHash !== command.scopeHash ||
          value.requestHash !== command.requestHash ||
          value.challenge !== challenge ||
          !signature ||
          signature.length !== expected.length ||
          !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
        )
          throw new Error('unqualified');
      } catch {
        throw new AppError(
          503,
          'WHOLE_ORDER_STATUS_NOT_SENT',
          'The qualified STORE receiver could not be verified. The status action was not sent.',
        );
      }
    }
    let response: Response;
    try {
      response = await fetcher(url, {
        method: read ? 'GET' : 'POST',
        headers: headers(command),
        ...(read
          ? {}
          : { body: JSON.stringify(sourceStatusBody(command.snapshot, command.platform)) }),
        redirect: 'error',
        signal: AbortSignal.timeout(options.WHOLE_ORDER_STATUS_HTTP_TIMEOUT_MS),
      });
    } catch {
      throw unknownStatusOutcome();
    }
    if (read && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw unknownStatusOutcome();
    }
    const value = await boundedJson(response, 65536);
    return verifiedReceipt(
      options.WHOLE_ORDER_STATUS_RECEIPT_KEY!,
      value,
      response.headers.get('x-pos-status-receipt'),
      {
        operationId: command.id,
        requestHash: command.requestHash,
        scopeHash: command.scopeHash,
        platform: command.platform,
      },
    );
  }
  return {
    configured,
    async send(command) {
      const receipt = await request(command, false);
      if (!receipt) throw unknownStatusOutcome();
      return receipt;
    },
    read(command) {
      return request(command, true);
    },
  };
}
