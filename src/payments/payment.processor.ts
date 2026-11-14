import { setTimeout as delay } from 'node:timers/promises';
import { InvalidStatusTransitionError } from '../errors';
import type { Logger } from '../logger';
import { GatewayUnavailableError, type ChargeResult, type PaymentGateway } from './payment.gateway';
import type { PaymentRepository } from './payment.repository';
import { applyTransition } from './payment.state-machine';
import type { Payment, PaymentFailure } from './payment.types';

/** What the rest of the app needs to know about background processing. */
export interface PaymentQueue {
  enqueue(paymentId: string): void;
}

export interface ProcessorOptions {
  /** Total gateway attempts per payment, including the first one. */
  maxAttempts: number;
  /** Delay before the first retry; doubles on each further retry. */
  baseBackoffMs: number;
  /** How long a single gateway call may take before it is abandoned. */
  attemptTimeoutMs: number;
  /** How many payments may be talking to the gateway at the same time. */
  maxConcurrency: number;
}

export class GatewayTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Payment gateway did not respond within ${timeoutMs}ms`);
    this.name = 'GatewayTimeoutError';
  }
}

type Settlement =
  | { status: 'successful'; gatewayReference: string }
  | { status: 'failed'; failure: PaymentFailure };

type Sleep = (ms: number) => Promise<unknown>;

/**
 * Drives a payment from "pending" to a terminal status in the background, so
 * the HTTP request that created it can return immediately.
 *
 * In production this would be a consumer on a durable queue (RabbitMQ, SQS,
 * Kafka). The in-process version keeps the properties that matter:
 *  - a payment is never processed twice at the same time;
 *  - concurrency is bounded, so a burst of payments cannot flood the gateway;
 *  - transient failures are retried with backoff, slow calls are timed out;
 *  - every charge carries an idempotency key, so a retry cannot double charge;
 *  - work interrupted by a crash or a storage error is found and resumed;
 *  - shutdown waits for payments that are mid-flight.
 */
export class PaymentProcessor implements PaymentQueue {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly waitingForSlot: Array<() => void> = [];
  private activeSlots = 0;
  private accepting = true;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repository: PaymentRepository,
    private readonly gateway: PaymentGateway,
    private readonly logger: Logger,
    private readonly options: ProcessorOptions,
    private readonly sleep: Sleep = (ms) => delay(ms),
  ) {}

  /**
   * Fire and forget: never throws, and never runs the same payment twice at
   * once. Returns whether the payment was newly queued.
   */
  enqueue(paymentId: string): boolean {
    if (!this.accepting || this.jobs.has(paymentId)) {
      return false;
    }
    const job = this.run(paymentId)
      .catch((error: unknown) => {
        // A storage failure lands here. The payment keeps its current status
        // and the recovery sweep picks it up again.
        this.logger.error({ err: error, paymentId }, 'Payment processing crashed, will be retried');
      })
      .finally(() => {
        this.jobs.delete(paymentId);
      });
    this.jobs.set(paymentId, job);
    return true;
  }

  /**
   * Queues every unfinished payment that nobody is working on: left over from
   * a previous run, or stranded by a storage error. Returns how many it queued.
   */
  async recoverInterrupted(): Promise<number> {
    const unfinished = await this.repository.findByStatus(['pending', 'processing']);
    return unfinished.filter((payment) => this.enqueue(payment.id)).length;
  }

  /** Runs recoverInterrupted() on a timer so stranded payments are not stuck until a restart. */
  startRecoverySweep(intervalMs: number): void {
    if (this.sweepTimer || intervalMs <= 0) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      this.recoverInterrupted()
        .then((recovered) => {
          if (recovered > 0) {
            this.logger.warn({ recovered }, 'Recovery sweep re-queued stranded payments');
          }
        })
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'Recovery sweep failed');
        });
    }, intervalMs);
    this.sweepTimer.unref(); // never keeps the process alive on its own
  }

  /** Resolves when nothing is queued or being processed. */
  async drain(): Promise<void> {
    while (this.jobs.size > 0) {
      await Promise.allSettled([...this.jobs.values()]);
    }
  }

  /**
   * Stops taking new work and waits for payments that are mid-flight.
   * Payments still waiting for a slot are left "pending" for the next start
   * rather than holding up the shutdown.
   */
  async shutdown(): Promise<void> {
    this.accepting = false;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    await this.drain();
  }

  private async run(paymentId: string): Promise<void> {
    await this.acquireSlot();
    try {
      if (this.accepting) {
        await this.process(paymentId);
      }
    } finally {
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeSlots < this.options.maxConcurrency) {
      this.activeSlots += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waitingForSlot.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.waitingForSlot.shift();
    if (next) {
      next(); // hand the slot straight to the next job in line
    } else {
      this.activeSlots -= 1;
    }
  }

  private async process(paymentId: string): Promise<void> {
    const log = this.logger.child({ paymentId });

    const payment = await this.claim(paymentId);
    if (!payment) {
      log.info('Skipping payment that is not awaiting processing');
      return;
    }

    log.info({ amount: payment.amount, currency: payment.currency }, 'Payment processing started');
    const settlement = await this.charge(payment, log);
    await this.settle(paymentId, settlement, log);
  }

  /**
   * Moves pending -> processing atomically. If the payment is gone or already
   * finished (for example it was failed manually), there is nothing to do.
   * A payment already in "processing" is one we are resuming.
   */
  private async claim(paymentId: string): Promise<Payment | null> {
    const payment = await this.repository.update(paymentId, (current) =>
      current.status === 'pending'
        ? applyTransition(current, 'processing', { reason: 'Processing started' })
        : current,
    );
    return payment?.status === 'processing' ? payment : null;
  }

  /** Calls the gateway with a timeout and exponential backoff. Always resolves to a settlement. */
  private async charge(payment: Payment, log: Logger): Promise<Settlement> {
    const { maxAttempts, baseBackoffMs } = this.options;

    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await this.chargeWithTimeout(payment);
        if (result.outcome === 'approved') {
          return { status: 'successful', gatewayReference: result.gatewayReference };
        }
        // A decline is a final answer from the provider. Retrying would not change it.
        return { status: 'failed', failure: { code: result.code, message: result.message } };
      } catch (error) {
        const timedOut = error instanceof GatewayTimeoutError;
        const retryable = timedOut || error instanceof GatewayUnavailableError;

        if (!retryable) {
          log.error({ err: error, attempt }, 'Unexpected error while charging payment');
          return {
            status: 'failed',
            failure: { code: 'processing_error', message: 'The payment could not be processed' },
          };
        }

        if (attempt >= maxAttempts) {
          log.error({ err: error, attempt }, 'Gateway still failing, giving up');
          return {
            status: 'failed',
            failure: timedOut
              ? { code: 'gateway_timeout', message: 'The payment provider did not respond in time' }
              : { code: 'gateway_unavailable', message: 'The payment provider is unavailable' },
          };
        }

        const retryInMs = baseBackoffMs * 2 ** (attempt - 1);
        log.warn({ err: error, attempt, retryInMs }, 'Transient gateway failure, will retry');
        await this.sleep(retryInMs);
      }
    }
  }

  private async chargeWithTimeout(payment: Payment): Promise<ChargeResult> {
    const { attemptTimeoutMs } = this.options;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new GatewayTimeoutError(attemptTimeoutMs));
        controller.abort(); // let a well-behaved gateway stop its work
      }, attemptTimeoutMs);
    });

    try {
      // The payment id doubles as the idempotency key: a timed-out attempt may
      // have gone through, and the key guarantees the retry cannot charge twice.
      // The race guards against a gateway that ignores the abort signal.
      return await Promise.race([
        this.gateway.charge(
          { idempotencyKey: payment.id, amount: payment.amount, currency: payment.currency },
          controller.signal,
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Records the outcome. If storage fails here the error propagates, the
   * payment stays "processing", and the recovery sweep runs it again; the
   * idempotency key makes the gateway return the same answer second time.
   */
  private async settle(paymentId: string, settlement: Settlement, log: Logger): Promise<void> {
    try {
      const updated = await this.repository.update(paymentId, (current) =>
        settlement.status === 'successful'
          ? applyTransition(current, 'successful', {
              reason: 'Approved by payment gateway',
              gatewayReference: settlement.gatewayReference,
            })
          : applyTransition(current, 'failed', {
              reason: settlement.failure.message,
              failure: settlement.failure,
            }),
      );
      if (!updated) {
        log.warn('Payment disappeared before it could be settled');
        return;
      }
      if (settlement.status === 'successful') {
        log.info({ status: 'successful' }, 'Payment settled');
      } else {
        log.warn({ status: 'failed', failureCode: settlement.failure.code }, 'Payment settled');
      }
    } catch (error) {
      if (error instanceof InvalidStatusTransitionError) {
        // Someone finalised the payment through the API while the gateway call
        // was in flight. The state machine protected the record; a real system
        // would raise this for reconciliation.
        log.warn(
          { gatewayOutcome: settlement.status },
          'Payment was finalised elsewhere during processing, keeping its existing status',
        );
        return;
      }
      throw error;
    }
  }
}
