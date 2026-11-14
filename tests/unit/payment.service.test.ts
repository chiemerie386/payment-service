import {
  IdempotencyConflictError,
  InvalidStatusTransitionError,
  PaymentNotFoundError,
} from '../../src/errors';
import { InMemoryPaymentRepository } from '../../src/payments/payment.repository';
import type { CreatePaymentInput } from '../../src/payments/payment.schemas';
import { PaymentService } from '../../src/payments/payment.service';
import { silentLogger } from '../helpers';

const input: CreatePaymentInput = {
  amount: 250000,
  currency: 'NGN',
  customerId: 'cus_10293',
  description: 'Order #5521',
  metadata: { orderId: '5521', channel: 'web' },
};
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

function setup() {
  const repository = new InMemoryPaymentRepository();
  const queue = { enqueue: jest.fn() };
  const service = new PaymentService(repository, queue, silentLogger);
  return { repository, queue, service };
}

describe('PaymentService', () => {
  describe('createPayment', () => {
    it('stores a pending payment and queues it for processing', async () => {
      const { service, repository, queue } = setup();

      const { payment, replayed } = await service.createPayment(input);

      expect(replayed).toBe(false);
      expect(payment).toMatchObject({ ...input, status: 'pending' });
      expect(payment.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(payment.statusHistory).toEqual([
        { status: 'pending', at: payment.createdAt, reason: 'Payment created' },
      ]);
      expect(await repository.findById(payment.id)).toEqual(payment);
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
      expect(queue.enqueue).toHaveBeenCalledWith(payment.id);
    });

    it('creates separate payments for identical requests without an idempotency key', async () => {
      const { service } = setup();

      const first = await service.createPayment(input);
      const second = await service.createPayment(input);

      expect(second.payment.id).not.toBe(first.payment.id);
    });

    it('returns the original payment when the idempotency key is replayed', async () => {
      const { service, queue, repository } = setup();

      const first = await service.createPayment(input, 'key-1');
      const second = await service.createPayment(input, 'key-1');

      expect(second.replayed).toBe(true);
      expect(second.payment.id).toBe(first.payment.id);
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
      expect(repository.snapshot()).toHaveLength(1);
    });

    it('treats a body with the same fields in a different order as the same request', async () => {
      const { service } = setup();
      const reordered: CreatePaymentInput = {
        metadata: { channel: 'web', orderId: '5521' },
        description: 'Order #5521',
        customerId: 'cus_10293',
        currency: 'NGN',
        amount: 250000,
      };

      await service.createPayment(input, 'key-1');
      const second = await service.createPayment(reordered, 'key-1');

      expect(second.replayed).toBe(true);
    });

    it('rejects an idempotency key that is reused with a different body', async () => {
      const { service } = setup();
      await service.createPayment(input, 'key-1');

      await expect(service.createPayment({ ...input, amount: 999 }, 'key-1')).rejects.toThrow(
        IdempotencyConflictError,
      );
    });

    it('creates exactly one payment when the same key arrives concurrently', async () => {
      const { service, repository, queue } = setup();

      const results = await Promise.all(
        Array.from({ length: 10 }, () => service.createPayment(input, 'key-1')),
      );

      expect(new Set(results.map((result) => result.payment.id)).size).toBe(1);
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(repository.snapshot()).toHaveLength(1);
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
    });

    it('propagates unexpected storage errors', async () => {
      const { service, repository } = setup();
      jest.spyOn(repository, 'insert').mockRejectedValue(new Error('disk full'));

      await expect(service.createPayment(input)).rejects.toThrow('disk full');
    });
  });

  describe('getPayment', () => {
    it('returns the stored payment', async () => {
      const { service } = setup();
      const { payment } = await service.createPayment(input);

      expect(await service.getPayment(payment.id)).toEqual(payment);
    });

    it('throws PaymentNotFoundError for an unknown id', async () => {
      const { service } = setup();

      await expect(service.getPayment(UNKNOWN_ID)).rejects.toThrow(PaymentNotFoundError);
    });
  });

  describe('updateStatus', () => {
    it('applies a valid transition and records it in the history', async () => {
      const { service } = setup();
      const { payment } = await service.createPayment(input);

      const updated = await service.updateStatus(payment.id, { status: 'processing' });

      expect(updated.status).toBe('processing');
      expect(updated.statusHistory.map((entry) => entry.status)).toEqual(['pending', 'processing']);
      expect(updated.statusHistory.at(-1)?.reason).toBe('Status updated via API');
    });

    it('stores the supplied reason as the failure when a payment is failed manually', async () => {
      const { service } = setup();
      const { payment } = await service.createPayment(input);

      const updated = await service.updateStatus(payment.id, {
        status: 'failed',
        reason: 'Cancelled by customer',
      });

      expect(updated.failure).toEqual({ code: 'manually_failed', message: 'Cancelled by customer' });
    });

    it('rejects a transition the lifecycle does not allow and leaves the payment untouched', async () => {
      const { service } = setup();
      const { payment } = await service.createPayment(input);

      await expect(service.updateStatus(payment.id, { status: 'successful' })).rejects.toThrow(
        InvalidStatusTransitionError,
      );
      expect((await service.getPayment(payment.id)).status).toBe('pending');
    });

    it('never lets a terminal payment change', async () => {
      const { service } = setup();
      const { payment } = await service.createPayment(input);
      await service.updateStatus(payment.id, { status: 'processing' });
      await service.updateStatus(payment.id, { status: 'successful' });

      await expect(service.updateStatus(payment.id, { status: 'failed' })).rejects.toThrow(
        InvalidStatusTransitionError,
      );
    });

    it('is a no-op when the payment is already in the requested status', async () => {
      const { service } = setup();
      const { payment } = await service.createPayment(input);
      const first = await service.updateStatus(payment.id, { status: 'processing' });

      const second = await service.updateStatus(payment.id, { status: 'processing' });

      expect(second).toEqual(first);
      expect(second.statusHistory).toHaveLength(2);
    });

    it('throws PaymentNotFoundError for an unknown id', async () => {
      const { service } = setup();

      await expect(service.updateStatus(UNKNOWN_ID, { status: 'processing' })).rejects.toThrow(
        PaymentNotFoundError,
      );
    });
  });
});
