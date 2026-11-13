export const PAYMENT_STATUSES = ['pending', 'processing', 'successful', 'failed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface PaymentFailure {
  /** Stable machine-readable reason, e.g. "insufficient_funds". */
  code: string;
  message: string;
}

export interface StatusChange {
  status: PaymentStatus;
  at: string;
  reason: string;
}

/** The payment as it is stored. Use toPaymentResponse() before sending it to a client. */
export interface Payment {
  id: string;
  /** Amount in the currency's minor unit (kobo, cents). Always an integer, never a float. */
  amount: number;
  /** ISO 4217 code, upper case. */
  currency: string;
  customerId: string;
  description?: string;
  metadata?: Record<string, string>;
  status: PaymentStatus;
  /** Present only when status is "failed". */
  failure?: PaymentFailure;
  /** Reference returned by the gateway once the charge is approved. */
  gatewayReference?: string;
  /** Append-only audit trail of every status the payment has been in. */
  statusHistory: StatusChange[];
  createdAt: string;
  updatedAt: string;

  // Internal bookkeeping, never exposed through the API.
  idempotencyKey?: string;
  requestFingerprint: string;
}

export type PaymentResponse = Omit<Payment, 'idempotencyKey' | 'requestFingerprint'>;

export function toPaymentResponse(payment: Payment): PaymentResponse {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { idempotencyKey, requestFingerprint, ...publicFields } = payment;
  return publicFields;
}
