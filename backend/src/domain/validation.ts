import { z } from 'zod';

export const identifier = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  .refine(
    (value) => /^[1-9]\d{0,19}$/.test(value)&&BigInt(value) <= 18_446_744_073_709_551_615n,
    'Identifier is outside the supported range.',
  );
export const cursor = z.union([z.literal('0'), identifier]);
