import { GatewayUnavailableError } from '../../src/payments/payment.gateway';
import { PaymentProcessor, type ProcessorOptions } from '../../src/payments/payment.processor';
import { InMemoryPaymentRepository } from '../../src/payments/payment.repository';
import { applyTransition } from '../../src/payments/payment.state-machine';
import { APPROVED, buildPayment, DECLINED, FAST_PROCESSING, mockGateway, silentLogger } from '../helpers';

const PAYMENT_ID = buildPayment().id;

function setup(options: Partial<ProcessorOptions> = {}, payments = [buildPayment()]) {
  const repository = new InMemoryPaymentRepository(payments);
  const gateway = mockGateway();
  const sleep = jest.fn(async () => undefined);
  const processor = new PaymentProcessor(
    repository,
    gateway,
    silentLogger,
    { ...FAST_PROCESSING, ...options },
    sleep,
  );
  return { repository, gateway, sleep, processor };
}

describe('PaymentProcessor', () => {
  it('moves an approved payment through processing to successful', async () => {
    const { repository, gateway, processor } = setup();
    gateway.charge.mockResolvedValue(APPROVED);

    processor.enqueue(PAYMENT_ID);
    await processor.drain();

    const payment = await repository.findById(PAYMENT_ID);
    expect(payment?.status).toBe('successful');
    expect(payment?.gatewayReference).toBe(APPROVED.gatewayReference);
    expect(payment?.statusHistory.map((entry) => entry.status)).toEqual([
      'pending',
      'processing',
      'successful',
    ]);
  });

  it('sends the gateway only what it needs, keyed by the payment id for idempotency', async () => {
    const { gateway, processor } = setup({}, [buildPayment({ description: 'private note' })]);
    gateway.charge.mockResolvedValue(APPROVED);

    processor.enqueue(PAYMENT_ID);
    await processor.drain();

    expect(gateway.charge).toHaveBeenCalledWith(
      { idempotencyKey: PAYMENT_ID, amount: 250000, currency: 'NGN' },
      expect.any(AbortSignal),
    );
  });

  it('marks the payment as processing while the gateway call is in flight', async () => {
    const { repository, gateway, processor } = setup();
    let approve: (() => void) | undefined;
    gateway.charge.mockReturnValue(
      new Promise((resolve) => {
        approve = () => resolve(APPROVED);
      }),
    );

    processor.enqueue(PAYMENT_ID);
    await new Promise((resolve) => setImmediate(resolve));

    expect((await repository.findById(PAYMENT_ID))?.status).toBe('processing');
    approve?.();
    await processor.drain();
    expect((await repository.findById(PAYMENT_ID))?.status).toBe('successful');
  });

  it('fails a declined payment with the gateway reason and does not retry', async () => {
    const { repository, gateway, sleep, processor } = setup();
    gateway.charge.mockResolvedValue(DECLINED);

    processor.enqueue(PAYMENT_ID);
    await processor.drain();

    const payment = await repository.findById(PAYMENT_ID);
    expect(payment?.status).toBe('failed');
    expect(payment?.failure).toEqual({ code: 'insufficient_funds', message: DECLINED.message });
    expect(gateway.charge).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries transient gateway errors with exponential backoff, then succeeds', async () => {
    const { repository, gateway, sleep, processor } = setup({ maxAttempts: 3, baseBackoffMs: 100 });
    gateway.charge
      .mockRejectedValueOnce(new GatewayUnavailableError())
      .mockRejectedValueOnce(new GatewayUnavailableError())
      .mockResolvedValueOnce(APPROVED);

    processor.enqueue(PAYMENT_ID);
    await processor.drain();

    expect((await repository.findById(PAYMENT_ID))?.status).toBe('successful');
    expect(gateway.charge).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[100], [200]]);
    // Every attempt carries the same key, so the provider can de-duplicate.
    const keys = gateway.charge.mock.calls.map(([request]) => request.idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([PAYMENT_ID]));
  });

  it('fails the payment as gateway_unavailable once retries are exhausted', async () => {
    const { repository, gateway, processor } = setup({ maxAttempts: 3 });
    gateway.charge.mockRejectedValue(new GatewayUnavailableError());

    processor.enqueue(PAYMENT_ID);
    await processor.drain();

    const payment = await repository.findById(PAYMENT_ID);
    expect(payment?.status).toBe('failed');
    expect(payment?.failure?.code).toBe('gateway_unavailable');
    expect(gateway.charge).toHaveBeenCalledTimes(3);
  });

  it('abandons a gateway call that exceeds the timeout and signals it to abort', async () => {
    const { repository, gateway, processor } = setup({ maxAttempts: 2, attemptTimeoutMs: 20 });
    const signals: AbortSignal[] = [];
    gateway.charge.mockImplementation((_payment, signal) => {
      signals.push(signal);
      return new Promise(() => undefined); // never settles
    });

    processor.enqueue(PAYMENT_ID);
    await processor.drain();

    const payment = await repository.findById(PAYMENT_ID);
    expect(payment?.status).toBe('failed');
    expect(payment?.failure?.code).toBe('gateway_timeout');
    expect(gateway.charge).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('fails the payment without retrying when the gateway throws an unexpected error', async () => {
    const { repository, gateway, processor } = setup();
    gateway.charge.mockRejectedValue(new TypeError('cannot read properties of undefined'));

    processor.enqueue(PAYMENT_ID);
    await processor.drain();

    const payment = await repository.findById(PAYMENT_ID);
    expect(payment?.status).toBe('failed');
    expect(payment?.failure).toEqual({
      code: 'processing_error',
      message: 'The payment could not be processed',
    });
    expect(gateway.charge).toHaveBeenCalledTimes(1);
  });

  it.each(['successful', 'failed'] as const)('never charges a payment that is already %s', async (status) => {
    const { repository, gateway, processor } = setup({}, [buildPayment({ status })]);

    processor.enqueue(PAYMENT_ID);
    await processor.drain();

    expect(gateway.charge).not.toHaveBeenCalled();
    expect((await repository.findById(PAYMENT_ID))?.status).toBe(status);
  });

  it('ignores an id that does not exist', async () => {
    const { gateway, processor } = setup();

    processor.enqueue('00000000-0000-4000-8000-000000000000');
    await processor.drain();

    expect(gateway.charge).not.toHaveBeenCalled();
  });

  it('does not process the same payment twice when it is enqueued twice', async () => {
    const { gateway, processor } = setup();
    gateway.charge.mockResolvedValue(APPROVED);

    processor.enqueue(PAYMENT_ID);
    processor.enqueue(PAYMENT_ID);
    await processor.drain();

    expect(gateway.charge).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing status if the payment is finalised elsewhere mid-flight', async () => {
    const { repository, gateway, processor } = setup();
    gateway.charge.mockImplementation(async () => {
      // Simulates an operator failing the payment while the gateway is working.
      await repository.update(PAYMENT_ID, (current) =>
        applyTransition(current, 'failed', { reason: 'Cancelled by customer' }),
      );
      return APPROVED;
    });

    processor.enqueue(PAYMENT_ID);
    await processor.drain();

    const payment = await repository.findById(PAYMENT_ID);
    expect(payment?.status).toBe('failed');
    expect(payment?.gatewayReference).toBeUndefined();
  });

  it('survives a storage failure without an unhandled rejection', async () => {
    const { repository, gateway, processor } = setup();
    jest.spyOn(repository, 'update').mockRejectedValue(new Error('storage offline'));

    processor.enqueue(PAYMENT_ID);
    await expect(processor.drain()).resolves.toBeUndefined();

    expect(gateway.charge).not.toHaveBeenCalled();
  });

  it('resumes payments that a previous run left pending or processing', async () => {
    const { repository, gateway, processor } = setup({}, [
      buildPayment({ id: 'a', status: 'pending' }),
      buildPayment({ id: 'b', status: 'processing' }),
      buildPayment({ id: 'c', status: 'successful' }),
      buildPayment({ id: 'd', status: 'failed' }),
    ]);
    gateway.charge.mockResolvedValue(APPROVED);

    const resumed = await processor.recoverInterrupted();
    await processor.drain();

    expect(resumed).toBe(2);
    expect(gateway.charge).toHaveBeenCalledTimes(2);
    expect((await repository.findById('a'))?.status).toBe('successful');
    expect((await repository.findById('b'))?.status).toBe('successful');
  });

  describe('bounded concurrency', () => {
    it('never has more payments at the gateway than maxConcurrency allows', async () => {
      const payments = Array.from({ length: 8 }, (_, index) => buildPayment({ id: `payment-${index}` }));
      const { repository, gateway, processor } = setup({ maxConcurrency: 3 }, payments);
      let atGateway = 0;
      let peak = 0;
      gateway.charge.mockImplementation(async () => {
        atGateway += 1;
        peak = Math.max(peak, atGateway);
        await new Promise((resolve) => setTimeout(resolve, 5));
        atGateway -= 1;
        return APPROVED;
      });

      payments.forEach((payment) => processor.enqueue(payment.id));
      await processor.drain();

      expect(peak).toBe(3);
      expect(gateway.charge).toHaveBeenCalledTimes(8);
      const statuses = (await repository.findByStatus(['successful'])).length;
      expect(statuses).toBe(8);
    });

    it('frees the slot when a job crashes, so later payments are not starved', async () => {
      const payments = [buildPayment({ id: 'a' }), buildPayment({ id: 'b' })];
      const { repository, gateway, processor } = setup({ maxConcurrency: 1 }, payments);
      gateway.charge.mockResolvedValue(APPROVED);
      jest.spyOn(repository, 'update').mockRejectedValueOnce(new Error('storage offline'));

      processor.enqueue('a');
      processor.enqueue('b');
      await processor.drain();

      expect((await repository.findById('b'))?.status).toBe('successful');
    });

    it('leaves payments that were still waiting for a slot pending on shutdown', async () => {
      const payments = [buildPayment({ id: 'a' }), buildPayment({ id: 'b' })];
      const { repository, gateway, processor } = setup({ maxConcurrency: 1 }, payments);
      let finishFirst: (() => void) | undefined;
      gateway.charge.mockReturnValueOnce(
        new Promise((resolve) => {
          finishFirst = () => resolve(APPROVED);
        }),
      );

      processor.enqueue('a');
      processor.enqueue('b');
      await new Promise((resolve) => setImmediate(resolve));
      const stopped = processor.shutdown();
      finishFirst?.();
      await stopped;

      expect((await repository.findById('a'))?.status).toBe('successful'); // mid-flight work finished
      expect((await repository.findById('b'))?.status).toBe('pending'); // resumed on next start
      expect(gateway.charge).toHaveBeenCalledTimes(1);
    });
  });

  describe('recovery', () => {
    it('re-runs a payment whose result could not be saved, without a second distinct charge', async () => {
      const { repository, gateway, processor } = setup();
      gateway.charge.mockResolvedValue(APPROVED);
      const realUpdate = repository.update.bind(repository);
      jest
        .spyOn(repository, 'update')
        .mockImplementationOnce(realUpdate) // claim succeeds
        .mockRejectedValueOnce(new Error('disk full')); // saving the outcome fails

      processor.enqueue(PAYMENT_ID);
      await processor.drain();
      expect((await repository.findById(PAYMENT_ID))?.status).toBe('processing'); // stranded

      const recovered = await processor.recoverInterrupted();
      await processor.drain();

      expect(recovered).toBe(1);
      expect((await repository.findById(PAYMENT_ID))?.status).toBe('successful');
      const keys = gateway.charge.mock.calls.map(([request]) => request.idempotencyKey);
      expect(keys).toEqual([PAYMENT_ID, PAYMENT_ID]); // same key: the provider de-duplicates
    });

    it('does not re-queue a payment that is already being processed', async () => {
      const { gateway, processor } = setup();
      let approve: (() => void) | undefined;
      gateway.charge.mockReturnValue(
        new Promise((resolve) => {
          approve = () => resolve(APPROVED);
        }),
      );

      processor.enqueue(PAYMENT_ID);
      await new Promise((resolve) => setImmediate(resolve));
      const recovered = await processor.recoverInterrupted();
      approve?.();
      await processor.drain();

      expect(recovered).toBe(0);
      expect(gateway.charge).toHaveBeenCalledTimes(1);
    });

    it('sweeps for stranded payments on a timer', async () => {
      const { repository, gateway, processor } = setup();
      gateway.charge.mockResolvedValue(APPROVED);

      processor.startRecoverySweep(10);
      await new Promise((resolve) => setTimeout(resolve, 60));
      await processor.shutdown();

      expect((await repository.findById(PAYMENT_ID))?.status).toBe('successful');
      expect(gateway.charge).toHaveBeenCalledTimes(1);
    });

    it('keeps sweeping after a sweep fails', async () => {
      const { repository, gateway, processor } = setup();
      gateway.charge.mockResolvedValue(APPROVED);
      jest.spyOn(repository, 'findByStatus').mockRejectedValueOnce(new Error('storage offline'));

      processor.startRecoverySweep(10);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await processor.shutdown();

      expect((await repository.findById(PAYMENT_ID))?.status).toBe('successful');
    });

    it('stops sweeping after shutdown', async () => {
      const { repository, processor } = setup();
      const findByStatus = jest.spyOn(repository, 'findByStatus');

      processor.startRecoverySweep(10);
      await processor.shutdown();
      findByStatus.mockClear();
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(findByStatus).not.toHaveBeenCalled();
    });

    it('does not start a sweep when the interval is zero', async () => {
      const { repository, processor } = setup();
      const findByStatus = jest.spyOn(repository, 'findByStatus');

      processor.startRecoverySweep(0);
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(findByStatus).not.toHaveBeenCalled();
    });
  });

  it('stops accepting work after shutdown', async () => {
    const { repository, gateway, processor } = setup();

    await processor.shutdown();
    processor.enqueue(PAYMENT_ID);
    await processor.drain();

    expect(gateway.charge).not.toHaveBeenCalled();
    expect((await repository.findById(PAYMENT_ID))?.status).toBe('pending');
  });
});
