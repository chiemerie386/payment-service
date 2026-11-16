# Payment Processing Simulation Service

A Node.js microservice that simulates payment processing. It exposes a REST API to create a payment, retrieve it, and update its status, and it processes each payment asynchronously against a simulated payment gateway.

Built with Node.js, TypeScript, Express 5, Zod, Pino and Jest.

## Contents

- [Quick start](#quick-start)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Failure handling](#failure-handling)
- [Security](#security)
- [API reference](#api-reference)
- [Running the tests](#running-the-tests)
- [Project structure](#project-structure)
- [Design decisions](#design-decisions)
- [What I would add for production](#what-i-would-add-for-production)

The AI transcript of the work is in [AI_TRANSCRIPT.md](AI_TRANSCRIPT.md).

## Quick start

Requires Node.js 22 or newer.

```bash
npm install
npm run dev          # starts on http://localhost:3000 with reload
```

Or run the compiled build:

```bash
npm run build
npm start
```

Then:

- Interactive API docs (Swagger UI): http://localhost:3000/docs
- OpenAPI document: http://localhost:3000/openapi.json
- Health check: http://localhost:3000/health

Try it:

```bash
# Create a payment (amount is in minor units: 250000 kobo = NGN 2,500.00)
curl -i -X POST http://localhost:3000/payments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-5521' \
  -d '{"amount": 250000, "currency": "NGN", "customerId": "cus_10293", "description": "Order #5521"}'

# Poll for the outcome (use the id from the response above)
curl http://localhost:3000/payments/<id>
```

## Configuration

Everything has a default, so no configuration is needed to run locally. To change a value, copy `.env.example` to `.env` (picked up by `npm run dev`) or set real environment variables. Invalid values stop the service at startup with a clear message.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `PERSISTENCE` | `memory` | `memory`, or `file` to keep payments in a JSON file across restarts. |
| `DATA_FILE` | `./data/payments.json` | Location of the JSON file when `PERSISTENCE=file`. |
| `AUTO_PROCESS` | `true` | Process new payments in the background. Set to `false` to drive every status change yourself through `PATCH`. |
| `GATEWAY_MIN_LATENCY_MS` / `GATEWAY_MAX_LATENCY_MS` | `200` / `1200` | Simulated gateway response time range. |
| `GATEWAY_DECLINE_RATE` | `0.2` | Share of charges the simulated gateway declines (0 to 1). |
| `GATEWAY_ERROR_RATE` | `0.1` | Share of gateway calls that fail transiently (0 to 1). |
| `PROCESSING_MAX_ATTEMPTS` | `3` | Gateway attempts per payment before giving up. |
| `PROCESSING_BACKOFF_MS` | `200` | Delay before the first retry. Doubles on each retry. |
| `PROCESSING_ATTEMPT_TIMEOUT_MS` | `5000` | Time allowed for a single gateway call. |
| `PROCESSING_MAX_CONCURRENCY` | `10` | How many payments may be at the gateway at once. |
| `RECOVERY_SWEEP_INTERVAL_MS` | `30000` | How often to look for stranded payments and resume them. `0` disables. |
| `API_KEYS` | empty | Comma-separated API keys (16+ characters each). Empty disables authentication. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `120` / `60000` | Requests allowed per client per window on `/payments`. `RATE_LIMIT_MAX=0` disables. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Maximum time to wait for in-flight payments on shutdown. |

Useful combinations when reviewing:

- Always succeed: `GATEWAY_DECLINE_RATE=0 GATEWAY_ERROR_RATE=0`
- Always decline: `GATEWAY_DECLINE_RATE=1 GATEWAY_ERROR_RATE=0`
- Gateway down (exercises retries): `GATEWAY_DECLINE_RATE=0 GATEWAY_ERROR_RATE=1`
- Manual mode: `AUTO_PROCESS=false`
- With authentication: `API_KEYS=$(openssl rand -hex 32)`, then send `Authorization: Bearer <key>`

## How it works

### Payment lifecycle

```
pending --> processing --> successful
   |             |
   +-------------+-------> failed
```

| From | Allowed next statuses |
| --- | --- |
| `pending` | `processing`, `failed` |
| `processing` | `successful`, `failed` |
| `successful` | none (terminal) |
| `failed` | none (terminal) |

A finished payment can never change. Every change is appended to the payment's `statusHistory`, which gives a full audit trail.

### Asynchronous processing

1. `POST /payments` validates the request, stores the payment as `pending`, and responds with `201` straight away. The client is never kept waiting on the gateway.
2. A background processor claims the payment (`pending` to `processing`) and calls the gateway.
3. The gateway answers after a random delay with one of three outcomes:
   - **Approved**: the payment becomes `successful` and stores the `gatewayReference`.
   - **Declined** (for example insufficient funds): the payment becomes `failed` with a `failure.code` and message. A decline is final, so it is not retried.
   - **Transient error or timeout**: retried with exponential backoff. If every attempt fails, the payment becomes `failed` with `gateway_unavailable` or `gateway_timeout`.
4. The client polls `GET /payments/:id` to see the result.

### Reliability of the background work

The processor is in-process, but it is built to behave like a proper queue consumer:

- **No double processing.** A payment can only be claimed while it is `pending`, and the same payment is never run twice at once.
- **Bounded concurrency.** At most `PROCESSING_MAX_CONCURRENCY` payments talk to the gateway at a time. A burst of traffic queues up instead of flooding the provider.
- **Retries cannot double charge.** Every gateway call carries the payment id as an idempotency key. If an attempt times out after the provider actually took the money, the retry gets the original result back instead of a second charge.
- **Nothing gets stuck.** A recovery sweep runs every `RECOVERY_SWEEP_INTERVAL_MS` and resumes any unfinished payment that nobody is working on, for example one whose result could not be saved.
- **Clean shutdown.** On `SIGTERM` or `SIGINT` the service stops accepting connections and lets payments that are mid-flight settle (up to `SHUTDOWN_TIMEOUT_MS`). Payments still waiting in the queue stay `pending`.
- **Crash recovery.** With `PERSISTENCE=file`, payments that were `pending` or `processing` when the process died are resumed on the next start.

The honest limit: with `PERSISTENCE=memory` a crash loses everything, queue included. That is inherent to in-memory storage and is the first thing a production version would replace (see the end of this document).

## Failure handling

The points where this service can fail, and what happens at each:

| What goes wrong | What the service does |
| --- | --- |
| Invalid or malicious input | Rejected with `400` and a per-field explanation before any work is done. Unknown fields are refused. |
| Malformed JSON, oversized body | `400 invalid_json`, `413 payload_too_large`. |
| Payment does not exist | `404 payment_not_found`. A malformed id is a `400`, not a `404`. |
| Illegal status change (for example `successful` to `failed`) | `409 invalid_status_transition`, listing the allowed next statuses. The payment is untouched. |
| Client retries a create after a network error | With an `Idempotency-Key`, the original payment is returned. No duplicate payment, no duplicate charge. |
| Same create sent concurrently | Exactly one payment is created; the others get the same payment back. |
| Gateway declines the charge | Payment becomes `failed` with the decline reason. Not retried, because the answer would not change. |
| Gateway is down or erroring | Retried with exponential backoff. After `PROCESSING_MAX_ATTEMPTS`, the payment becomes `failed` with `gateway_unavailable`. |
| Gateway hangs | Each call is cut off after `PROCESSING_ATTEMPT_TIMEOUT_MS` and retried. Ends as `failed` with `gateway_timeout`. |
| Gateway code throws something unexpected | Payment becomes `failed` with `processing_error`. The real error goes to the logs only. |
| A status update races with background processing | Updates are atomic, so exactly one wins. The loser is logged (processor) or gets a `409` (API). The record never ends up in a mixed state. |
| Storage fails while saving a new payment | The request gets a `500` and the payment does not exist anywhere. The client can safely retry. |
| Storage fails while saving a processing result | The payment stays `processing`; the recovery sweep runs it again and the gateway's idempotency returns the same result. |
| Process crashes mid-payment | With file storage, the payment is resumed on restart. The data file is replaced atomically, so it is never left half-written. |
| Data file is corrupt at startup | The service refuses to start, rather than silently starting empty and losing payment records. |
| Bad configuration | The service refuses to start and names the offending variable. |
| Port already in use | Logged as fatal, exit code 1. |
| A bug throws inside a request | Caught centrally: logged with stack trace and request id, client gets an opaque `500 internal_error`. |
| A bug escapes outside a request (unhandled rejection) | Logged as fatal and the process exits, so a supervisor restarts it in a clean state. |
| Too many requests from one client | `429 rate_limited` with a `Retry-After` header. |
| Shutdown during processing | Mid-flight payments are allowed to finish; a hard deadline prevents hanging forever. |

Every row is covered by automated tests except the process-level ones (port in use, unhandled rejection, the shutdown deadline). Those live in `server.ts`, the startup wiring, and were verified by hand.

## Security

- **Authentication.** Set `API_KEYS` and every `/payments` route requires `Authorization: Bearer <key>` (or `X-API-Key`). Keys are compared in constant time. Several keys can be active at once, which allows rotation without downtime. It is off by default so the project runs with zero setup, and the service logs a warning at startup while it is off.
- **Rate limiting** per client on `/payments`. It runs before authentication, so it also slows down attempts to guess a key.
- **Strict input validation** on every body, path parameter and header, using an allow-list approach: unknown fields are rejected, strings have length limits, amounts have bounds, and metadata keys are restricted (including `__proto__` and `constructor`, to rule out prototype pollution).
- **No mass assignment.** Clients cannot set `id`, `status` or timestamps. Internal fields are stripped from every response.
- **No sensitive payment data.** The API deliberately does not accept card numbers or CVVs. A real integration would use provider-side tokens so this service stays out of PCI scope.
- **Nothing leaks in errors.** Stack traces and internal messages go to the logs only.
- **Safe logging.** Authorization headers are redacted, customer free text is not logged, and caller-supplied request ids are checked before being logged or echoed.
- **Hardened HTTP surface.** Helmet security headers, `Cache-Control: no-store` on payment data, a 10kb body limit, and no `X-Powered-By` header.
- **Unguessable ids.** Payment ids are random UUIDs, so they cannot be enumerated.
- **Dependencies.** Versions are pinned by the lockfile and `npm audit --omit=dev` reports no known vulnerabilities at the time of writing.

Not covered, by design for a simulation: per-customer authorisation (any valid key can read any payment), TLS termination (expected at the load balancer), and secrets management (keys come from the environment). If the service runs behind a reverse proxy, set Express' `trust proxy` so the rate limiter sees real client addresses.

## API reference

The same information is available interactively at `/docs`.

### Payment object

```json
{
  "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "amount": 250000,
  "currency": "NGN",
  "customerId": "cus_10293",
  "description": "Order #5521",
  "metadata": { "orderId": "5521" },
  "status": "failed",
  "failure": { "code": "insufficient_funds", "message": "The account has insufficient funds" },
  "statusHistory": [
    { "status": "pending", "at": "2026-01-15T09:30:00.000Z", "reason": "Payment created" },
    { "status": "processing", "at": "2026-01-15T09:30:00.004Z", "reason": "Processing started" },
    { "status": "failed", "at": "2026-01-15T09:30:00.750Z", "reason": "The account has insufficient funds" }
  ],
  "createdAt": "2026-01-15T09:30:00.000Z",
  "updatedAt": "2026-01-15T09:30:00.750Z"
}
```

- `failure` is present only when `status` is `failed`. Codes: `insufficient_funds`, `card_declined`, `expired_card`, `gateway_unavailable`, `gateway_timeout`, `processing_error`, `manually_failed`.
- `gatewayReference` is present only once the gateway has approved the charge.

### POST /payments

Creates a payment and queues it for processing.

Request body:

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `amount` | integer | yes | Minor currency units (kobo, cents). Greater than 0, at most 100,000,000,000. |
| `currency` | string | yes | One of `NGN`, `GHS`, `KES`, `ZAR`, `TZS`, `UGX`, `USD`, `EUR`, `GBP`. |
| `customerId` | string | yes | 1 to 64 characters. |
| `description` | string | no | Up to 255 characters. |
| `metadata` | object | no | Up to 20 string key/value pairs. Keys: letters, digits, `_`, `.`, `-`, up to 40 characters. |

Unknown fields are rejected, so a client cannot set `status` or `id` itself.

Optional header: `Idempotency-Key` (1 to 255 printable characters). If a request is retried with the same key and the same body, the original payment is returned and no second payment is created. This makes it safe for clients to retry after a network failure.

Responses:

| Status | When |
| --- | --- |
| `201 Created` | Payment created. `Location` header points to it. Body is the payment with `status: "pending"`. |
| `200 OK` | Idempotent replay. Header `Idempotent-Replayed: true`. Body is the original payment in its current state. |
| `400 Bad Request` | Validation failed (`validation_error`) or the body is not valid JSON (`invalid_json`). |
| `401 Unauthorized` | Missing or wrong API key, when `API_KEYS` is set (`unauthorized`). Applies to every `/payments` route. |
| `413 Payload Too Large` | Body larger than 10kb (`payload_too_large`). |
| `429 Too Many Requests` | Rate limit exceeded (`rate_limited`). Applies to every `/payments` route. |
| `422 Unprocessable Entity` | The `Idempotency-Key` was already used with a different body (`idempotency_key_reused`). |

### GET /payments/:id

Returns the payment.

| Status | When |
| --- | --- |
| `200 OK` | Body is the payment. |
| `400 Bad Request` | `id` is not a UUID (`validation_error`). |
| `404 Not Found` | No payment has this id (`payment_not_found`). |

### PATCH /payments/:id

Updates the status of a payment. `PUT` on the same path behaves identically.

```bash
curl -X PATCH http://localhost:3000/payments/<id> \
  -H 'Content-Type: application/json' \
  -d '{"status": "failed", "reason": "Cancelled by customer"}'
```

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `status` | string | yes | `processing`, `successful` or `failed`. |
| `reason` | string | no | Up to 255 characters. Recorded in `statusHistory`, and as the failure message when failing a payment. |

| Status | When |
| --- | --- |
| `200 OK` | Status updated. Body is the updated payment. Sending the status the payment already has is a no-op and also returns `200`, so retries are safe. |
| `400 Bad Request` | Invalid body or id (`validation_error`, `invalid_json`). |
| `404 Not Found` | No payment has this id (`payment_not_found`). |
| `409 Conflict` | The lifecycle does not allow this change (`invalid_status_transition`). `details` lists what is allowed. |

With the default `AUTO_PROCESS=true` the background processor usually finishes a payment within about a second, after which it is terminal. To step through the lifecycle by hand, start the service with `AUTO_PROCESS=false`.

### GET /health

Returns `200` with `{ "status": "ok", "uptimeSeconds": 42 }`.

### Error format

Every error, including unknown routes and unexpected failures, uses the same shape:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "details": [
      { "field": "amount", "message": "amount must be greater than zero" }
    ],
    "requestId": "3f2b1c9e-8a7d-4e6f-9b0a-1c2d3e4f5a6b"
  }
}
```

- `code` is stable and meant for programs. `message` is meant for people.
- `details` appears only where it adds something (invalid fields, allowed transitions).
- `requestId` matches the `X-Request-Id` response header and every log line for that request. Send your own `X-Request-Id` to trace a call across services.
- Unexpected errors return `500` with code `internal_error` and a generic message. The stack trace goes to the logs, never to the client.

### How payment processing failures are reported

A declined or failed charge is a normal business outcome, not an HTTP error. Because processing is asynchronous, the create call has already returned `201` by the time the gateway answers, so the failure is reported on the payment itself: `status: "failed"` plus a `failure` object. HTTP error codes are reserved for problems with the request (4xx) or with this service (5xx).

## Running the tests

```bash
npm test                 # all unit and integration tests
npm run test:coverage    # with a coverage report (thresholds enforced)
npm run typecheck        # TypeScript, no emit
npm run lint             # ESLint
```

The tests need no running server, database or network. What is covered:

| File | What it proves |
| --- | --- |
| `tests/unit/payment.state-machine.test.ts` | Every allowed and disallowed transition, terminal statuses, immutability of the transition function. |
| `tests/unit/payment.service.test.ts` | Creation, idempotency (replay, conflict, concurrent requests), status updates, not-found handling. |
| `tests/unit/payment.processor.test.ts` | Success, decline, retry with backoff, retry exhaustion, timeout, unexpected errors, racing manual updates, the concurrency limit, the recovery sweep, crash recovery, shutdown. |
| `tests/unit/payment.repository.test.ts` | One contract suite run against both the in-memory and the file store, plus file durability, disk write failures and corruption handling. |
| `tests/unit/payment.gateway.test.ts` | The simulated gateway's outcomes, idempotency, latency and cancellation, using an injected random source. |
| `tests/unit/config.test.ts` | Defaults, coercion and fail-fast validation of environment variables. |
| `tests/integration/payments.api.test.ts` | The real Express app end to end over HTTP: status codes, headers, error bodies, validation of each field, authentication, rate limiting, and the full asynchronous flow. |

Tests are deterministic: the gateway is replaced with a scripted double, and backoff sleeps and the random source are injected, so no test depends on chance or on long real waits.

## Project structure

```
src/
  server.ts                      Entry point: wiring, startup, graceful shutdown
  app.ts                         Express app factory (no listening, so tests can use it)
  config.ts                      Environment parsing and validation
  logger.ts                      Pino logger
  errors.ts                      Typed application errors with status and code
  middleware/
    request-context.ts           Request id, per-request logger, access log
    error-handler.ts             404 handler and the single error-to-response mapper
    security.ts                  API key authentication, rate limiting, cache headers
  payments/
    payment.types.ts             Payment model and response mapper
    payment.schemas.ts           Zod schemas for all input
    payment.state-machine.ts     Lifecycle rules (pure functions)
    payment.repository.ts        Storage interface and in-memory store
    file-payment.repository.ts   JSON file store
    payment.gateway.ts           Gateway interface and simulated gateway
    payment.processor.ts         Background processing: claim, charge, retry, settle, recover
    payment.service.ts           Business operations used by the API
    payment.routes.ts            HTTP routes
  docs/
    openapi.ts                   OpenAPI 3 document
tests/
  unit/                          One file per module
  integration/                   HTTP-level tests with supertest
```

Dependencies point inwards: routes call the service, and the service and processor depend on the `PaymentRepository` and `PaymentGateway` interfaces rather than on concrete classes. `server.ts` is the only file that chooses implementations.

## Design decisions

**Create returns immediately, processing happens in the background.** Real gateways are slow and unreliable. Holding the HTTP request open while calling one ties up connections and gives the client no good answer when the call times out. Returning `201` with `pending` and letting the client poll (or, in a real system, receive a webhook) is how production payment APIs behave.

**Amounts are integers in minor units.** `0.1 + 0.2 !== 0.3` in floating point, which is unacceptable for money. Storing kobo or cents as integers removes the problem entirely.

**The lifecycle lives in one pure function.** `applyTransition` is the only code that changes a status. The API and the background processor both go through it, so there is exactly one place where the rules are defined and tested, and no code path can put a payment into an illegal state.

**Updates are atomic.** `repository.update(id, mutate)` reads, validates and writes as a single step. Two concurrent updates (for example the processor settling a payment while a client cancels it) cannot both succeed from the same starting status. One wins, the other gets a conflict. With a SQL database the same contract maps to `UPDATE ... WHERE id = $1 AND status = $2`.

**Idempotency keys on create.** Networks fail between "the server processed it" and "the client heard back". Without idempotency, a client retry charges the customer twice. The key is enforced by the store, like a unique constraint, so it also holds under concurrent requests.

**Declines are data, outages are exceptions.** The gateway returns a decline and throws on infrastructure failure. That distinction decides what is retried: retrying a decline is pointless, retrying an outage is useful.

**One error shape, one place that produces it.** Handlers throw typed errors and the error middleware maps them. Anything that is not a known error type is treated as a bug: logged with its stack, returned as an opaque `500`.

**Structured logs with correlation.** Logs are JSON with a `requestId` on request lines and a `paymentId` on processing lines, so one payment's journey can be followed in any log tool. Customer-supplied free text (`description`, `metadata`) is not logged.

**PATCH and PUT.** `PATCH` is the correct verb for changing one field. `PUT` is accepted as an alias because the brief allows either.

**Saved before acknowledged.** The file store only makes a change visible after it is on disk. A failed write can therefore never produce a payment the client was told about but that is not saved, or the reverse.

**Authentication is opt-in.** A payment API with no authentication is not acceptable in production, but a take-home that needs secrets configured before it will answer a request is hostile to reviewers. So it is one environment variable away, off by default, and loud about being off.

**Scope.** The brief asks for a simulation, so storage is in-memory or a JSON file and the queue is in-process. Both sit behind interfaces so the real thing can replace them without touching business logic.

## What I would add for production

- A real database (PostgreSQL) with transactions, and a durable queue (RabbitMQ, SQS or Kafka) with a dead-letter queue in place of the in-process processor, so the service can run as several instances and survive crashes without file storage.
- Per-customer authorisation, hashed keys in a secrets store, and a shared rate-limit store (Redis) so limits hold across instances.
- Webhooks so clients are told the outcome instead of polling.
- Jitter on retry backoff and a circuit breaker around the gateway.
- Metrics and tracing (Prometheus, OpenTelemetry), with alerts on failure rate and processing latency.
- Reconciliation against the provider's records, and alerting when the processor and a manual update disagree about an outcome.
- Expiry for idempotency keys, a list endpoint with pagination, and refunds.
- A Dockerfile and a CI pipeline running lint, typecheck and tests.
