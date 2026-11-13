import { InvalidStatusTransitionError } from '../errors';
import type { Payment, PaymentFailure, PaymentStatus } from './payment.types';

/**
 * The single source of truth for the payment lifecycle:
 *
 *   pending --> processing --> successful
 *      |             |
 *      +-------------+-------> failed
 *
 * "successful" and "failed" are terminal: money has moved (or definitively
 * has not), so the record is immutable from that point on.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  pending: ['processing', 'failed'],
  processing: ['successful', 'failed'],
  successful: [],
  failed: [],
};

export function allowedTransitions(from: PaymentStatus): readonly PaymentStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: PaymentStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

export interface TransitionOptions {
  reason: string;
  failure?: PaymentFailure;
  gatewayReference?: string;
  at?: string;
}

/**
 * Pure function: returns a new payment in the target status or throws
 * InvalidStatusTransitionError. The input is never mutated, which makes the
 * rule trivial to unit test and safe to run inside a repository update.
 */
export function applyTransition(
  payment: Payment,
  to: PaymentStatus,
  options: TransitionOptions,
): Payment {
  if (!canTransition(payment.status, to)) {
    throw new InvalidStatusTransitionError(payment.status, to, allowedTransitions(payment.status));
  }

  const at = options.at ?? new Date().toISOString();
  const next: Payment = {
    ...payment,
    status: to,
    updatedAt: at,
    statusHistory: [...payment.statusHistory, { status: to, at, reason: options.reason }],
  };

  if (to === 'failed') {
    next.failure = options.failure ?? { code: 'unknown', message: options.reason };
  }
  if (options.gatewayReference) {
    next.gatewayReference = options.gatewayReference;
  }
  return next;
}
