import { ZodError } from 'zod';
import { AppError } from '../domain/errors.js';
import { validationIssues } from '../domain/route-validation.js';

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    fields?: ReturnType<typeof validationIssues>;
  };
}
export interface MappedError {
  status: number;
  body: ErrorEnvelope;
  /** Safe classification for logs (error code / driver code, never a message or SQL). */
  logCode: string;
  /** Unexpected server-side failures are logged at error level. */
  unexpected: boolean;
}

/** Framework (4xx) rejections, by status: a stable code and a clear, value-free message. */
const frameworkRejections: Record<number, [string, string]> = {
  400: ['INVALID_REQUEST', 'The request is malformed. Check the submitted data and try again.'],
  401: ['AUTH_REQUIRED', 'Sign in to continue.'],
  403: ['FORBIDDEN', 'You do not have access to this action.'],
  404: ['NOT_FOUND', 'The requested resource was not found.'],
  405: ['METHOD_NOT_ALLOWED', 'This action is not supported for this resource.'],
  406: ['NOT_ACCEPTABLE', 'The requested response format is not supported.'],
  409: ['CONFLICT', 'The request conflicts with the current state. Refresh and try again.'],
  413: ['PAYLOAD_TOO_LARGE', 'The request is too large.'],
  414: ['URI_TOO_LONG', 'The request address is too long.'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'Send the request as JSON.'],
  423: ['RESOURCE_LOCKED', 'This resource is locked by another action. Try again shortly.'],
  429: ['RATE_LIMITED', 'Too many requests. Try again shortly.'],
  431: ['HEADERS_TOO_LARGE', 'The request headers are too large.'],
};

/**
 * MySQL driver errors (mysql2, possibly wrapped by drizzle as `cause`) mapped by their code to the
 * S4 status that fits. The SQL text, parameters and server message are never returned or logged.
 */
const databaseErrors: Record<string, [number, string, string]> = {
  ER_DUP_ENTRY: [409, 'DUPLICATE_RECORD', 'This record already exists. Refresh and try again.'],
  ER_LOCK_DEADLOCK: [
    409,
    'CONCURRENT_UPDATE',
    'Another action changed this record at the same time. Try again.',
  ],
  ER_LOCK_WAIT_TIMEOUT: [
    423,
    'RESOURCE_LOCKED',
    'This record is locked by another action. Try again shortly.',
  ],
  ER_NO_REFERENCED_ROW_2: [
    409,
    'REFERENCED_RECORD_MISSING',
    'A related record no longer exists. Refresh and try again.',
  ],
  ER_ROW_IS_REFERENCED_2: [
    409,
    'RECORD_IN_USE',
    'This record is still referenced by other records and cannot be changed.',
  ],
  ER_CON_COUNT_ERROR: [503, 'DEPENDENCY_UNAVAILABLE', 'The database is busy. Try again shortly.'],
  PROTOCOL_CONNECTION_LOST: [
    503,
    'DEPENDENCY_UNAVAILABLE',
    'The database is unavailable. Try again shortly.',
  ],
  ECONNREFUSED: [
    503,
    'DEPENDENCY_UNAVAILABLE',
    'A required service is unavailable. Try again shortly.',
  ],
  ETIMEDOUT: [503, 'DEPENDENCY_UNAVAILABLE', 'A required service timed out. Try again shortly.'],
  ECONNRESET: [
    503,
    'DEPENDENCY_UNAVAILABLE',
    'A required service is unavailable. Try again shortly.',
  ],
};

function driverCode(error: unknown): string | null {
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    if (typeof current !== 'object') return null;
    const code = 'code' in current ? current.code : undefined;
    if (typeof code === 'string' && /^(ER_[A-Z0-9_]+|PROTOCOL_[A-Z_]+|E[A-Z]+)$/.test(code))
      return code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return null;
}

/** The S4 error contract: status that fits the scenario, stable code, clear value-free message. */
export function mapError(error: unknown, requestId: string): MappedError {
  const envelope = (
    code: string,
    message: string,
    extra: Partial<ErrorEnvelope['error']> = {},
  ) => ({
    error: { code, message, requestId, ...extra },
  });
  if (error instanceof ZodError)
    return {
      status: 400,
      body: envelope('INVALID_REQUEST', 'Some request fields are missing or invalid.', {
        fields: validationIssues(error.issues),
      }),
      logCode: 'INVALID_REQUEST',
      unexpected: false,
    };
  if (error instanceof AppError)
    return {
      status: error.status,
      body: envelope(error.code, error.message),
      logCode: error.code,
      unexpected: error.status >= 500,
    };
  const code = driverCode(error);
  const database = code ? databaseErrors[code] : undefined;
  if (database)
    return {
      status: database[0],
      body: envelope(database[1], database[2]),
      logCode: code!,
      unexpected: database[0] >= 500,
    };
  const status =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number(error.statusCode)
      : 500;
  if (status >= 400 && status < 500) {
    const [rejectionCode, message] = frameworkRejections[status] ?? [
      'REQUEST_REJECTED',
      'The request was rejected.',
    ];
    return {
      status,
      body: envelope(rejectionCode, message),
      logCode: rejectionCode,
      unexpected: false,
    };
  }
  return {
    status: 500,
    body: envelope('INTERNAL_ERROR', 'The request could not be completed.'),
    logCode: code ?? 'INTERNAL_ERROR',
    unexpected: true,
  };
}
