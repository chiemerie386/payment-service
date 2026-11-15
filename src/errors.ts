/**
 * Errors the service raises on purpose. Each one carries the HTTP status and
 * a stable machine-readable code, so the error middleware can translate it
 * without knowing anything about the domain. Anything that is NOT an AppError
 * is treated as a bug and reported as a generic 500.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export interface FieldProblem {
  field: string;
  message: string;
}

export class ValidationError extends AppError {
  constructor(problems: FieldProblem[], message = 'Request validation failed') {
    super(400, 'validation_error', message, problems);
  }
}

export class UnauthorizedError extends AppError {
  constructor() {
    super(401, 'unauthorized', 'A valid API key is required');
  }
}

export class RateLimitedError extends AppError {
  constructor() {
    super(429, 'rate_limited', 'Too many requests, please slow down and retry later');
  }
}

export class PaymentNotFoundError extends AppError {
  constructor(id: string) {
    super(404, 'payment_not_found', `Payment ${id} was not found`);
  }
}

export class InvalidStatusTransitionError extends AppError {
  constructor(from: string, to: string, allowed: readonly string[]) {
    super(
      409,
      'invalid_status_transition',
      `A payment cannot move from "${from}" to "${to}"`,
      { from, to, allowed },
    );
  }
}

export class IdempotencyConflictError extends AppError {
  constructor() {
    super(
      422,
      'idempotency_key_reused',
      'This Idempotency-Key was already used with a different request body',
    );
  }
}

/** Raised by repositories, the way a database raises a unique constraint violation. */
export class DuplicateIdempotencyKeyError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`A payment with idempotency key "${idempotencyKey}" already exists`);
    this.name = 'DuplicateIdempotencyKeyError';
  }
}
