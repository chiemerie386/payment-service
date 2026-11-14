import { createHash, randomUUID } from 'node:crypto';
import {
  DuplicateIdempotencyKeyError,
  IdempotencyConflictError,
  PaymentNotFoundError,
} from '../errors';
import type { Logger } from '../logger';
import type { PaymentQueue } from './payment.processor';
import type { PaymentRepository } from './payment.repository';
import type { CreatePaymentInput, UpdatePaymentStatusInput } from './payment.schemas';
import { applyTransition } from './payment.state-machine';
import type { Payment } from './payment.types';

export interface CreatePaymentResult {
  payment: Payment;
  /** True when an earlier request with the same Idempotency-Key already created this payment. */
  replayed: boolean;
}

/** Business rules for payments. Knows nothing about HTTP. */
export class PaymentService {
  constructor(
    private readonly repository: PaymentRepository,
    private readonly queue: PaymentQueue,
    private readonly logger: Logger,
  ) {}

  async createPayment(input: CreatePaymentInput, idempotencyKey?: string): Promise<CreatePaymentResult> {
    const now = new Date().toISOString();
    const candidate: Payment = {
      id: randomUUID(),
      amount: input.amount,
      currency: input.currency,
      customerId: input.customerId,
      ...(input.description !== undefined && { description: input.description }),
      ...(input.metadata !== undefined && { metadata: input.metadata }),
      status: 'pending',
      statusHistory: [{ status: 'pending', at: now, reason: 'Payment created' }],
      createdAt: now,
      updatedAt: now,
      ...(idempotencyKey !== undefined && { idempotencyKey }),
      requestFingerprint: fingerprint(input),
    };

    let payment: Payment;
    try {
      payment = await this.repository.insert(candidate);
    } catch (error) {
      if (error instanceof DuplicateIdempotencyKeyError) {
        return this.replay(error.idempotencyKey, candidate.requestFingerprint);
      }
      throw error;
    }

    this.logger.info(
      { paymentId: payment.id, amount: payment.amount, currency: payment.currency },
      'Payment created',
    );
    this.queue.enqueue(payment.id);
    return { payment, replayed: false };
  }

  async getPayment(id: string): Promise<Payment> {
    const payment = await this.repository.findById(id);
    if (!payment) {
      throw new PaymentNotFoundError(id);
    }
    return payment;
  }

  async updateStatus(id: string, input: UpdatePaymentStatusInput): Promise<Payment> {
    let changed = false;

    const payment = await this.repository.update(id, (current) => {
      if (current.status === input.status) {
        // Repeating an update is a no-op, so clients can retry safely.
        return current;
      }
      changed = true;
      const reason = input.reason ?? 'Status updated via API';
      return applyTransition(current, input.status, {
        reason,
        ...(input.status === 'failed' && { failure: { code: 'manually_failed', message: reason } }),
      });
    });

    if (!payment) {
      throw new PaymentNotFoundError(id);
    }
    if (changed) {
      this.logger.info({ paymentId: id, status: payment.status }, 'Payment status updated via API');
    }
    return payment;
  }

  private async replay(idempotencyKey: string, requestFingerprint: string): Promise<CreatePaymentResult> {
    const existing = await this.repository.findByIdempotencyKey(idempotencyKey);
    if (!existing) {
      // Cannot happen with the bundled stores; guards a misbehaving repository.
      throw new Error(`Idempotency key "${idempotencyKey}" is taken but its payment is missing`);
    }
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new IdempotencyConflictError();
    }
    this.logger.info({ paymentId: existing.id }, 'Idempotent replay, returning existing payment');
    return { payment: existing, replayed: true };
  }
}

/** Hash of the request body that ignores key order, used to detect idempotency key reuse. */
function fingerprint(input: CreatePaymentInput): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
}
