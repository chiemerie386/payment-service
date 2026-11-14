import { z } from 'zod';
import { ValidationError } from '../errors';

/** Upper bound keeps amounts far inside the safe integer range (and catches fat-finger input). */
export const MAX_AMOUNT_MINOR_UNITS = 100_000_000_000;

export const SUPPORTED_CURRENCIES = ['NGN', 'GHS', 'KES', 'ZAR', 'TZS', 'UGX', 'USD', 'EUR', 'GBP'] as const;

/**
 * Keys that could interfere with object internals if the metadata is ever
 * merged or copied carelessly downstream. Rejected outright rather than
 * silently dropped.
 */
const FORBIDDEN_METADATA_KEYS = ['__proto__', 'constructor', 'prototype'];

function hasNoForbiddenKeys(value: unknown): boolean {
  return (
    typeof value !== 'object' ||
    value === null ||
    !FORBIDDEN_METADATA_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

const metadataSchema = z
  .unknown()
  .refine(hasNoForbiddenKeys, `metadata keys must not be any of: ${FORBIDDEN_METADATA_KEYS.join(', ')}`)
  .pipe(
    z
      .record(
        z.string().regex(/^[\w.-]{1,40}$/, 'metadata keys may use letters, digits, "_", "." and "-" (max 40)'),
        z.string({ error: 'metadata values must be strings' }).max(255),
      )
      .refine((value) => Object.keys(value).length <= 20, 'metadata supports at most 20 keys'),
  );

export const createPaymentSchema = z.strictObject({
  amount: z
    .number({ error: 'amount must be a number' })
    .int('amount must be an integer in the minor currency unit (e.g. kobo, cents)')
    .positive('amount must be greater than zero')
    .max(MAX_AMOUNT_MINOR_UNITS, `amount must not exceed ${MAX_AMOUNT_MINOR_UNITS}`),
  currency: z.enum(SUPPORTED_CURRENCIES, {
    error: `currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
  }),
  customerId: z
    .string({ error: 'customerId is required and must be a string' })
    .trim()
    .min(1, 'customerId must not be blank')
    .max(64, 'customerId must be at most 64 characters'),
  description: z.string().trim().max(255).optional(),
  metadata: metadataSchema.optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

/**
 * "pending" is deliberately absent: it is only ever the initial status,
 * nothing can transition back into it.
 */
export const updatePaymentStatusSchema = z.strictObject({
  status: z.enum(['processing', 'successful', 'failed'], {
    error: 'status must be one of: processing, successful, failed',
  }),
  reason: z.string().trim().min(1).max(255).optional(),
});
export type UpdatePaymentStatusInput = z.infer<typeof updatePaymentStatusSchema>;

export const paymentIdSchema = z.object({
  id: z.uuid('id must be a valid UUID'),
});

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain only printable ASCII characters without spaces');

/** Parses untrusted input and converts schema failures into the API's ValidationError. */
export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, location?: string): T {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  throw new ValidationError(
    result.error.issues.map((issue) => ({
      field: [location, ...issue.path].filter((part) => part !== undefined).join('.') || 'body',
      message: issue.message,
    })),
  );
}
