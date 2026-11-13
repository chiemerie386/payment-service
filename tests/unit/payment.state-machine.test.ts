import { InvalidStatusTransitionError } from '../../src/errors';
import {
  allowedTransitions,
  applyTransition,
  canTransition,
  isTerminal,
} from '../../src/payments/payment.state-machine';
import { PAYMENT_STATUSES, type PaymentStatus } from '../../src/payments/payment.types';
import { buildPayment } from '../helpers';

describe('payment state machine', () => {
  const allowed: Array<[PaymentStatus, PaymentStatus]> = [
    ['pending', 'processing'],
    ['pending', 'failed'],
    ['processing', 'successful'],
    ['processing', 'failed'],
  ];

  it.each(allowed)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('rejects every transition that is not explicitly allowed', () => {
    const allowedKeys = new Set(allowed.map(([from, to]) => `${from}>${to}`));
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        if (!allowedKeys.has(`${from}>${to}`)) {
          expect([from, to, canTransition(from, to)]).toEqual([from, to, false]);
        }
      }
    }
  });

  it('treats successful and failed as terminal', () => {
    expect(isTerminal('successful')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('processing')).toBe(false);
    expect(allowedTransitions('successful')).toEqual([]);
  });

  describe('applyTransition', () => {
    const at = '2026-01-15T09:31:00.000Z';

    it('returns a new payment in the target status and appends to the history', () => {
      const payment = buildPayment();

      const next = applyTransition(payment, 'processing', { reason: 'Processing started', at });

      expect(next.status).toBe('processing');
      expect(next.updatedAt).toBe(at);
      expect(next.statusHistory).toEqual([
        ...payment.statusHistory,
        { status: 'processing', at, reason: 'Processing started' },
      ]);
    });

    it('does not mutate the payment it was given', () => {
      const payment = buildPayment();
      const before = structuredClone(payment);

      applyTransition(payment, 'processing', { reason: 'Processing started' });

      expect(payment).toEqual(before);
    });

    it('records the failure details when a payment fails', () => {
      const failure = { code: 'insufficient_funds', message: 'The account has insufficient funds' };

      const next = applyTransition(buildPayment({ status: 'processing' }), 'failed', {
        reason: failure.message,
        failure,
      });

      expect(next.failure).toEqual(failure);
    });

    it('falls back to a generic failure when none is supplied', () => {
      const next = applyTransition(buildPayment(), 'failed', { reason: 'Cancelled' });

      expect(next.failure).toEqual({ code: 'unknown', message: 'Cancelled' });
    });

    it('stores the gateway reference on success', () => {
      const next = applyTransition(buildPayment({ status: 'processing' }), 'successful', {
        reason: 'Approved',
        gatewayReference: 'sim_123',
      });

      expect(next.gatewayReference).toBe('sim_123');
      expect(next.failure).toBeUndefined();
    });

    it('throws a 409 error describing what is allowed when the transition is invalid', () => {
      const attempt = () => applyTransition(buildPayment({ status: 'successful' }), 'failed', { reason: 'x' });

      expect(attempt).toThrow(InvalidStatusTransitionError);
      try {
        attempt();
      } catch (error) {
        expect(error).toMatchObject({
          statusCode: 409,
          code: 'invalid_status_transition',
          details: { from: 'successful', to: 'failed', allowed: [] },
        });
      }
    });

    it('does not allow skipping straight from pending to successful', () => {
      expect(() => applyTransition(buildPayment(), 'successful', { reason: 'x' })).toThrow(
        InvalidStatusTransitionError,
      );
    });
  });
});
