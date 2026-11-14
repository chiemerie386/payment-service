import { GatewayUnavailableError, SimulatedPaymentGateway } from '../../src/payments/payment.gateway';
import { CHARGE_REQUEST } from '../helpers';

const instant = { minLatencyMs: 0, maxLatencyMs: 0, declineRate: 0.2, errorRate: 0.1 };

/** Returns the queued numbers in order, standing in for Math.random. */
function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

describe('SimulatedPaymentGateway', () => {
  const signal = () => new AbortController().signal;

  it('approves when the roll is above the error and decline bands', async () => {
    const gateway = new SimulatedPaymentGateway(instant, sequence(0, 0.9));

    const result = await gateway.charge(CHARGE_REQUEST, signal());

    expect(result).toEqual({ outcome: 'approved', gatewayReference: expect.stringMatching(/^sim_/) });
  });

  it('declines with a reason when the roll lands in the decline band', async () => {
    const gateway = new SimulatedPaymentGateway(instant, sequence(0, 0.15, 0));

    const result = await gateway.charge(CHARGE_REQUEST, signal());

    expect(result).toEqual({
      outcome: 'declined',
      code: 'insufficient_funds',
      message: 'The account has insufficient funds',
    });
  });

  it('throws a transient error when the roll lands in the error band', async () => {
    const gateway = new SimulatedPaymentGateway(instant, sequence(0, 0.05));

    await expect(gateway.charge(CHARGE_REQUEST, signal())).rejects.toThrow(GatewayUnavailableError);
  });

  it('always approves when both rates are zero', async () => {
    const gateway = new SimulatedPaymentGateway({ ...instant, declineRate: 0, errorRate: 0 });

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        gateway.charge({ ...CHARGE_REQUEST, idempotencyKey: `payment-${index}` }, signal()),
      ),
    );

    expect(results.every((result) => result.outcome === 'approved')).toBe(true);
  });

  describe('idempotency', () => {
    it('returns the original result when the same charge is retried, instead of charging again', async () => {
      // First call: approved. A fresh roll on the retry would have been a decline.
      const gateway = new SimulatedPaymentGateway(instant, sequence(0, 0.9, 0, 0.15, 0));

      const first = await gateway.charge(CHARGE_REQUEST, signal());
      const retry = await gateway.charge(CHARGE_REQUEST, signal());

      expect(first.outcome).toBe('approved');
      expect(retry).toEqual(first);
    });

    it('remembers declines too', async () => {
      const gateway = new SimulatedPaymentGateway(instant, sequence(0, 0.15, 0, 0, 0.9));

      const first = await gateway.charge(CHARGE_REQUEST, signal());
      const retry = await gateway.charge(CHARGE_REQUEST, signal());

      expect(first.outcome).toBe('declined');
      expect(retry).toEqual(first);
    });

    it('does not remember transient errors, so a retry gets a real attempt', async () => {
      const gateway = new SimulatedPaymentGateway(instant, sequence(0, 0.05, 0, 0.9));

      await expect(gateway.charge(CHARGE_REQUEST, signal())).rejects.toThrow(GatewayUnavailableError);
      const retry = await gateway.charge(CHARGE_REQUEST, signal());

      expect(retry.outcome).toBe('approved');
    });

    it('treats different idempotency keys as different charges', async () => {
      const gateway = new SimulatedPaymentGateway({ ...instant, declineRate: 0, errorRate: 0 });

      const first = await gateway.charge({ ...CHARGE_REQUEST, idempotencyKey: 'a' }, signal());
      const second = await gateway.charge({ ...CHARGE_REQUEST, idempotencyKey: 'b' }, signal());

      expect(second).not.toEqual(first);
    });
  });

  it('waits for the simulated latency before answering', async () => {
    const gateway = new SimulatedPaymentGateway(
      { ...instant, minLatencyMs: 40, maxLatencyMs: 40 },
      sequence(0, 0.9),
    );
    const startedAt = Date.now();

    await gateway.charge(CHARGE_REQUEST, signal());

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);
  });

  it('stops waiting as soon as the caller aborts', async () => {
    const gateway = new SimulatedPaymentGateway({ ...instant, minLatencyMs: 60_000, maxLatencyMs: 60_000 });
    const controller = new AbortController();

    const charge = gateway.charge(CHARGE_REQUEST, controller.signal);
    controller.abort();

    await expect(charge).rejects.toMatchObject({ name: 'AbortError' });
  });
});
