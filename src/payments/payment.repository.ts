import { DuplicateIdempotencyKeyError } from '../errors';
import type { Payment, PaymentStatus } from './payment.types';

/**
 * Storage port. The service and processor depend on this interface only, so
 * swapping the in-memory store for PostgreSQL means writing one new class.
 */
export interface PaymentRepository {
  /** @throws DuplicateIdempotencyKeyError when the idempotency key is already taken. */
  insert(payment: Payment): Promise<Payment>;
  findById(id: string): Promise<Payment | null>;
  findByIdempotencyKey(key: string): Promise<Payment | null>;
  findByStatus(statuses: readonly PaymentStatus[]): Promise<Payment[]>;
  /**
   * Atomic read-modify-write. The mutator receives the current payment and
   * returns the next version; if it throws, nothing is written. Because the
   * check and the write happen as one step, two concurrent updates can never
   * both act on the same stale status (the equivalent of
   * `UPDATE ... WHERE status = $expected` in SQL).
   *
   * Resolves to null when the payment does not exist.
   */
  update(id: string, mutate: (current: Payment) => Payment): Promise<Payment | null>;
}

export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly payments = new Map<string, Payment>();
  private readonly idsByIdempotencyKey = new Map<string, string>();

  constructor(initial: readonly Payment[] = []) {
    for (const payment of initial) {
      this.put(structuredClone(payment));
    }
  }

  async insert(payment: Payment): Promise<Payment> {
    if (payment.idempotencyKey && this.idsByIdempotencyKey.has(payment.idempotencyKey)) {
      throw new DuplicateIdempotencyKeyError(payment.idempotencyKey);
    }
    this.put(structuredClone(payment));
    return structuredClone(payment);
  }

  async findById(id: string): Promise<Payment | null> {
    const payment = this.payments.get(id);
    // Copies go out so callers can never mutate stored state by reference.
    return payment ? structuredClone(payment) : null;
  }

  async findByIdempotencyKey(key: string): Promise<Payment | null> {
    const id = this.idsByIdempotencyKey.get(key);
    return id ? this.findById(id) : null;
  }

  async findByStatus(statuses: readonly PaymentStatus[]): Promise<Payment[]> {
    return this.snapshot().filter((payment) => statuses.includes(payment.status));
  }

  async update(id: string, mutate: (current: Payment) => Payment): Promise<Payment | null> {
    const current = this.payments.get(id);
    if (!current) {
      return null;
    }
    // No await between reading and writing: on Node's single thread this
    // whole block is atomic.
    const next = mutate(structuredClone(current));
    this.payments.set(id, structuredClone(next));
    return structuredClone(next);
  }

  snapshot(): Payment[] {
    return [...this.payments.values()].map((payment) => structuredClone(payment));
  }

  private put(payment: Payment): void {
    this.payments.set(payment.id, payment);
    if (payment.idempotencyKey) {
      this.idsByIdempotencyKey.set(payment.idempotencyKey, payment.id);
    }
  }
}
