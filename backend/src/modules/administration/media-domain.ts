import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { pageQuery } from './contracts.js';

export const mediaKind = z.enum(['cover-image', 'image', 'video', 'document']);
export type MediaKind = z.infer<typeof mediaKind>;
export const mediaTypes = {
  'image/jpeg': { extension: 'jpg', kind: 'image', max: 10 * 1024 * 1024 },
  'image/png': { extension: 'png', kind: 'image', max: 10 * 1024 * 1024 },
  'image/webp': { extension: 'webp', kind: 'image', max: 10 * 1024 * 1024 },
  'image/gif': { extension: 'gif', kind: 'image', max: 10 * 1024 * 1024 },
  'video/mp4': { extension: 'mp4', kind: 'video', max: 100 * 1024 * 1024 },
  'video/webm': { extension: 'webm', kind: 'video', max: 100 * 1024 * 1024 },
  'application/pdf': { extension: 'pdf', kind: 'document', max: 25 * 1024 * 1024 },
  'text/plain': { extension: 'txt', kind: 'document', max: 5 * 1024 * 1024 },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    extension: 'docx',
    kind: 'document',
    max: 25 * 1024 * 1024,
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    extension: 'xlsx',
    kind: 'document',
    max: 25 * 1024 * 1024,
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    extension: 'pptx',
    kind: 'document',
    max: 25 * 1024 * 1024,
  },
} as const;
export type MediaContentType = keyof typeof mediaTypes;
export const uploadInput = z
  .object({
    id: z.uuid(),
    kind: mediaKind,
    name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\p{C}/\\]/u.test(value)),
    contentType: z.enum(Object.keys(mediaTypes) as [MediaContentType, ...MediaContentType[]]),
    size: z
      .number()
      .int()
      .min(1)
      .max(100 * 1024 * 1024),
    checksum: z
      .string()
      .regex(/^[A-Za-z0-9+/]{43}=$/)
      .refine((value) => Buffer.from(value, 'base64').toString('base64') === value),
  })
  .strict()
  .superRefine((value, context) => {
    const type = mediaTypes[value.contentType];
    if (type.kind !== (value.kind === 'cover-image' ? 'image' : value.kind))
      context.addIssue({
        code: 'custom',
        path: ['contentType'],
        message: 'File type does not match its attachment category.',
      });
    if (value.size > type.max)
      context.addIssue({
        code: 'custom',
        path: ['size'],
        message: 'File exceeds the allowed attachment size.',
      });
  });
export type UploadInput = z.infer<typeof uploadInput>;
export const assetReference = z.union([z.uuid(), z.string().regex(/^legacy-[0-9a-f]{32}$/)]);
export const documentationInput = z
  .object({
    operationId: z.uuid(),
    expectedVersion: z.number().int().min(0).max(2_147_483_646),
    title: z.string().trim().min(1).max(100),
    summary: z.string().trim().min(1).max(500),
    description: z.string().max(1000),
    keywords: z.string().trim().max(1000).default(''),
    sortOrder: z.number().int().min(-2_147_483_648).max(2_147_483_647),
    retainAssetIds: z.array(assetReference).max(80).default([]),
    uploadIds: z.array(z.uuid()).max(40).default([]),
  })
  .strict();
export type DocumentationInput = z.infer<typeof documentationInput>;
export const documentationPageQuery = pageQuery.omit({ after: true }).extend({
  limit: z.coerce.number().int().min(1).max(500).default(30),
  sort: z
    .enum(['id', 'title', 'summary', 'uploader', 'sortOrder', 'updatedAt', 'active'])
    .optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  after: z
    .string()
    .regex(/^(?:0|v1\.[A-Za-z0-9_-]{1,200}|c1\.[A-Za-z0-9_-]{1,4096})$/)
    .default('0'),
});
const cursorSchema = z
  .object({ sort: z.number().int().min(-2_147_483_648).max(2_147_483_647), id: identifier })
  .strict();
export const decodeDocumentationCursor = (value: string) =>
  value === '0'
    ? null
    : cursorSchema.parse(
        JSON.parse(Buffer.from(value.slice(3), 'base64url').toString('utf8')) as unknown,
      );
export const encodeDocumentationCursor = (sort: number, id: bigint) =>
  `v1.${Buffer.from(JSON.stringify({ sort, id: String(id) })).toString('base64url')}`;
export const assetDigest = (key: string) => createHash('sha256').update(key).digest('hex');
export const legacyAssetId = (kind: MediaKind, key: string) =>
  `legacy-${assetDigest(`${kind}\0${key}`).slice(0, 32)}`;
export const utcMediaTimestamp = (instant = Temporal.Now.instant()) =>
  instant
    .toZonedDateTimeISO('UTC')
    .toPlainDateTime()
    .toString({ smallestUnit: 'millisecond' })
    .replace('T', ' ');
export const sanitizeDocumentationHtml = (source: string) =>
  sanitizeHtml(source, {
    allowedTags: [
      'p',
      'br',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'h2',
      'h3',
      'h4',
      'ul',
      'ol',
      'li',
      'blockquote',
      'pre',
      'code',
      'table',
      'thead',
      'tbody',
      'tr',
      'td',
      'th',
      'a',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'rel'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['https'],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tag, attributes) => ({
        tagName: 'a',
        attribs: {
          ...(attributes.href ? { href: attributes.href } : {}),
          ...(attributes.title ? { title: attributes.title } : {}),
          rel: 'noopener noreferrer',
        },
      }),
    },
  });

/** Parse only string lists used by Python repr; never evaluate source metadata as code. */
export function parseLegacyAssetList(value: string | null): string[] {
  // pos_tutorial media columns are nullable; legacy ast.literal_eval(None) raises
  // (core/views.py:2512-2514), so NULL is invalid metadata, not an empty list.
  if (value === null) throw new Error('Legacy asset list is NULL.');
  if (!value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return z.array(z.string().max(1024)).max(100).parse(parsed);
  } catch {
    /* Older rows use Python list repr. */
  }
  let position = 0;
  const result: string[] = [];
  const spaces = () => {
    while (/\s/.test(value[position] || '') && position < value.length) position++;
  };
  const invalid = () =>
    new AppError(
      409,
      'DOCUMENTATION_METADATA_INVALID',
      'This guide has invalid attachment metadata.',
    );
  spaces();
  if (value[position++] !== '[') throw invalid();
  spaces();
  while (value[position] !== ']') {
    const quote = value[position++];
    if (quote !== "'" && quote !== '"') throw invalid();
    let entry = '',
      closed = false;
    while (position < value.length) {
      const character = value[position++];
      if (character === quote) {
        closed = true;
        break;
      }
      if (character === '\\') {
        const escaped = value[position++];
        if (escaped === '\\' || escaped === "'" || escaped === '"') entry += escaped;
        else if (escaped === 'n') entry += '\n';
        else if (escaped === 'r') entry += '\r';
        else if (escaped === 't') entry += '\t';
        else if (escaped === 'x' || escaped === 'u') {
          const width = escaped === 'x' ? 2 : 4,
            hex = value.slice(position, position + width);
          if (!new RegExp(`^[a-f0-9]{${width}}$`, 'i').test(hex)) throw invalid();
          entry += String.fromCharCode(parseInt(hex, 16));
          position += width;
        } else throw invalid();
      } else entry += character;
    }
    if (!closed || entry.length > 1024 || result.length >= 100) throw invalid();
    result.push(entry);
    spaces();
    if (value[position] === ',') {
      position++;
      spaces();
      if (value[position] === ']') break;
    } else if (value[position] !== ']') throw invalid();
  }
  position++;
  spaces();
  if (position !== value.length) throw invalid();
  return result;
}
export function mediaMagicMatches(contentType: MediaContentType, bytes: Uint8Array): boolean {
  const data = Buffer.from(bytes);
  if (contentType === 'image/png')
    return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === 'image/jpeg') return data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (contentType === 'image/gif') return /^GIF8[79]a/.test(data.toString('ascii'));
  if (contentType === 'image/webp')
    return data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
  if (contentType === 'video/mp4') return data.subarray(4, 8).toString() === 'ftyp';
  if (contentType === 'video/webm')
    return data.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  if (contentType === 'application/pdf') return data.subarray(0, 5).toString() === '%PDF-';
  if (contentType === 'text/plain') return !data.includes(0);
  return data.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]));
}
