import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

/** Only what the provider needs. The full payment record never leaves the service. */
export interface ChargeRequest {
  /**
   * Identifies the charge across retries. A provider that sees the same key
   * twice returns the original result instead of charging again, which is
   * what makes retrying after a timeout or a crash safe.
   */
  idempotencyKey: string;
  amount: number;
  currency: string;
}

export type ChargeResult =
  | { outcome: 'approved'; gatewayReference: string }
  | { outcome: 'declined'; code: string; message: string };

/**
 * Port for the external payment provider. A decline is a normal business
 * result and is RETURNED; infrastructure trouble (provider down, network) is
 * THROWN as GatewayUnavailableError so the caller knows a retry is worthwhile.
 */
export interface PaymentGateway {
  charge(request: ChargeRequest, signal: AbortSignal): Promise<ChargeResult>;
}

/** Transient failure: the charge was not attempted, retrying is safe. */
export class GatewayUnavailableError extends Error {
  constructor(message = 'Payment gateway is temporarily unavailable') {
    super(message);
    this.name = 'GatewayUnavailableError';
  }
}

export interface SimulatedGatewayOptions {
  minLatencyMs: number;
  maxLatencyMs: number;
  /** Probability (0..1) that a charge is declined. */
  declineRate: number;
  /** Probability (0..1) that the gateway errors out transiently. */
  errorRate: number;
}

const DECLINE_REASONS = [
  { code: 'insufficient_funds', message: 'The account has insufficient funds' },
  { code: 'card_declined', message: 'The card was declined by the issuer' },
  { code: 'expired_card', message: 'The card has expired' },
] as const;

/** Upper bound on remembered results so the simulation cannot grow without limit. */
const MAX_REMEMBERED_CHARGES = 10_000;

/**
 * Stands in for a real provider: waits a random amount of time (network
 * latency), then approves, declines, or fails transiently. Like a real
 * provider it remembers the final answer per idempotency key. The random
 * source is injectable so tests are fully deterministic.
 */
export class SimulatedPaymentGateway implements PaymentGateway {
  private readonly completed = new Map<string, ChargeResult>();

  constructor(
    private readonly options: SimulatedGatewayOptions,
    private readonly random: () => number = Math.random,
  ) {}

  async charge(request: ChargeRequest, signal: AbortSignal): Promise<ChargeResult> {
    const { minLatencyMs, maxLatencyMs, declineRate, errorRate } = this.options;
    const latency = minLatencyMs + Math.floor(this.random() * (maxLatencyMs - minLatencyMs + 1));
    // Rejects with an AbortError if the caller gives up (timeout or shutdown).
    await sleep(latency, undefined, { signal });

    const previous = this.completed.get(request.idempotencyKey);
    if (previous) {
      return previous;
    }

    const roll = this.random();
    if (roll < errorRate) {
      // Nothing is remembered: the charge never happened, so a retry starts fresh.
      throw new GatewayUnavailableError();
    }

    let result: ChargeResult;
    if (roll < errorRate + declineRate) {
      const index = Math.floor(this.random() * DECLINE_REASONS.length);
      const reason = DECLINE_REASONS[index] ?? DECLINE_REASONS[0];
      result = { outcome: 'declined', code: reason.code, message: reason.message };
    } else {
      result = { outcome: 'approved', gatewayReference: `sim_${randomUUID()}` };
    }
    this.remember(request.idempotencyKey, result);
    return result;
  }

  private remember(idempotencyKey: string, result: ChargeResult): void {
    if (this.completed.size >= MAX_REMEMBERED_CHARGES) {
      const oldest = this.completed.keys().next().value;
      if (oldest !== undefined) {
        this.completed.delete(oldest);
      }
    }
    this.completed.set(idempotencyKey, result);
  }
}
