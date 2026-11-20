import { z } from 'zod';

/**
 * Registered renderer (`process: 'renderer'`) events, with the fixed message logged for each.
 * The backend beacon (`backend/src/observability/client-errors.ts`) and the desktop main process
 * accept exactly these IDs.
 */
export const uiEvents = {
  'ui.render.failed': 'A view failed to render',
  'ui.window.error': 'An uncaught error reached the window',
  'ui.promise.unhandled': 'A promise rejection was not handled',
} as const;
export type UiEventId = keyof typeof uiEvents;
export const uiEventIds = Object.keys(uiEvents) as [UiEventId, ...UiEventId[]];

/** An error class name such as `TypeError`; never the message. */
export const errorNameSchema = z.string().regex(/^[A-Za-z_$][\w$]{0,63}$/);
/** A route pattern: the first path segment, then `:id` for every deeper segment. */
export const routePatternSchema = z
  .string()
  .max(128)
  .regex(/^\/(?:(?:[a-z][a-z0-9-]{0,39}|:id)(?:\/:id){0,7})?$/);

/** ID-only UI error report: never a message, stack, component props or query values. */
export const uiErrorReportSchema = z
  .object({
    eventId: z.enum(uiEventIds),
    errorName: errorNameSchema,
    route: routePatternSchema,
  })
  .strict();
export type UiErrorReport = z.infer<typeof uiErrorReportSchema>;

/** The class name of a thrown value, or a fixed fallback; never its message or contents. */
export function errorNameOf(error: unknown): string {
  const name =
    error instanceof Error
      ? error.name
      : error === null
        ? 'Null'
        : typeof error === 'object'
          ? 'NonErrorObject'
          : `Non${typeof error === 'string' ? 'String' : 'Error'}Value`;
  return errorNameSchema.safeParse(name).success ? name : 'Error';
}

/**
 * The route without values: the first segment (an application section such as `orders`) and
 * `:id` for each deeper segment, which can hold order numbers, phone numbers or names. The query
 * string and hash are dropped.
 */
export function routePattern(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean).slice(0, 8);
  if (!segments.length) return '/';
  const [first, ...rest] = segments;
  const section = /^[a-z][a-z0-9-]{0,39}$/.test(first!) ? first! : ':id';
  return '/' + [section, ...rest.map(() => ':id')].join('/');
}
