import { createLogger } from '../src/logger';
import type { Payment } from '../src/payments/payment.types';

export const silentLogger = createLogger('silent');

export function buildPayment(overrides: Partial<Payment> = {}): Payment {
  const createdAt = '2026-01-15T09:30:00.000Z';
  return {
    id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    amount: 250000,
    currency: 'NGN',
    customerId: 'cus_10293',
    status: 'pending',
    statusHistory: [{ status: 'pending', at: createdAt, reason: 'Payment created' }],
    createdAt,
    updatedAt: createdAt,
    requestFingerprint: 'fingerprint',
    ...overrides,
  };
}
