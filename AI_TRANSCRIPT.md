# AI transcript

## How I worked

I set myself five rules before starting, and the transcript below follows them:

1. **I make the design decisions.** I ask the AI for options and trade-offs, then choose. Where I overrode it, I say so.
2. **Small steps.** One piece per exchange, one commit per piece. Each exchange below names the commit it produced.
3. **Nothing is committed until it runs.** Typecheck, lint and tests pass on my machine first.
4. **I read every line before it goes in.** If I cannot explain a line, it does not get committed.
5. **When the AI and I disagree, or when it sounds confident, I test it.** Several of the corrections below came from running something instead of trusting an answer.

## How to read this

- **Prompts are reproduced as I sent them.**
- **AI replies are summarised, not quoted in full.** The full output of almost every reply was code, and that code is in the repository. Each section names the commit its reply produced, so the complete result can be read with `git show <commit>`.
- **What the commits cannot show is the drafts I rejected.** Those exist only in this document. Each section describes them under "What I did with it", and they are collected in one table at the end.

---

## 1. Reading the brief and planning

No commit. I wanted the decisions made before any code existed.

### Prompt

~~~~text
I'm doing a take-home assessment. The brief and the reviewers' side note are pasted below.

Do NOT write any code yet. I want three things:

1. Every ambiguity in the brief where I have to make a decision myself.
2. Every point where a service like this can fail, including the boring ones.
3. For the main design questions, the options and their trade-offs. Don't pick for me.

[brief pasted]
[side note pasted]
~~~~

### AI reply (summary)

**Ambiguities you need to decide:**

- Does `POST /payments` wait for the payment to finish, or return straight away and process in the background?
- If the service processes payments itself, what is the status update endpoint for? A manual override, a webhook from the provider, or the only way statuses change?
- PUT or PATCH. The brief allows either.
- How is the amount represented? The brief does not say.
- Which statuses exist beyond the three examples, and which changes between them are legal?
- In-memory or file persistence.
- Authentication is not mentioned in the brief, but the side note asks for secure coding practices.

**Where it can fail:** invalid input; malformed JSON; unknown id; illegal status change; the same create request sent twice; two updates to one payment at the same moment; the provider declining; the provider being down; the provider hanging; a crash while a payment is being processed; a failed disk write; a corrupt data file; shutdown while work is in flight; bad configuration; a bug.

**Options** (summarised): synchronous create is simpler but ties the request to the provider's latency and gives no good answer on timeout, while asynchronous create needs a background worker and a way to poll. For the queue, in-process is the simplest, and a real queue (BullMQ on Redis was suggested) is the most robust. For amounts, decimals are readable but floats are unsafe for money, and integer minor units are the standard fix.

### What I did with it

My decisions, and why:

| Question | Decision | Reason |
| --- | --- | --- |
| Sync or async create | Async. Return `201` with `pending`, process in the background. | It is how real payment APIs behave, and it is the only version that demonstrates the "asynchronous programming" the brief asks for. |
| Purpose of the update endpoint | A manual or provider-driven update that obeys the same lifecycle rules as the processor. | One set of rules, enforced in one place. |
| PUT or PATCH | PATCH, with PUT accepted as an alias. | PATCH is correct for changing one field. The alias costs one line and matches the brief. |
| Amount | Integer minor units. | `0.1 + 0.2 !== 0.3`. |
| Statuses | `pending`, `processing`, `successful`, `failed`. The last two are final. | `processing` is needed so a payment is never picked up twice. |
| Persistence | Both, behind one interface. In-memory by default. | Small extra cost, and it proves the abstraction works. |
| Queue | In-process, behind a small interface. | See below. |
| Language | TypeScript, strict. | The payment model has enough shape that types catch real mistakes. |

**Where I overrode the AI:** it leaned towards BullMQ and Redis for the queue. I rejected that. The brief says in-memory or file persistence "for simplicity", and a reviewer should be able to run this with `npm install` and nothing else. A solution that needs Redis running is worse for this brief, not better. I kept the queue in-process and wrote the real queue up under production next steps in the README.

---

## 2. Scaffold and configuration

Commits: `chore: scaffold TypeScript project with Jest and ESLint`, `feat: validated configuration and structured logger`

### Prompt

~~~~text
Set up the project: TypeScript in strict mode, Jest with ts-jest, ESLint with typescript-eslint, scripts for dev, build, test, typecheck and lint.

Then a config module. All configuration comes from environment variables, everything has a default so the project runs with no setup, and it is validated ONCE at startup with Zod. A bad value must stop the service with a message that names the variable. Include a boolean AUTO_PROCESS.

Then a Pino logger. JSON to stdout. Redact anything that could carry credentials.
~~~~

### AI reply (summary)

Produced `package.json`, the TypeScript, Jest and ESLint configs, `src/config.ts` and `src/logger.ts`. The first draft of the config schema declared the boolean as `AUTO_PROCESS: z.coerce.boolean().default(true)`.

### Follow-up prompt

~~~~text
Before I accept this: what does z.coerce.boolean() return for the string "false"? Environment variables are always strings.
~~~~

### AI reply (summary)

It returns `true`. `z.coerce.boolean()` applies `Boolean(value)`, and any non-empty string is truthy, so `AUTO_PROCESS=false` would switch the feature on. Replaced with an explicit parse that accepts only `"true"` or `"false"` and rejects anything else.

### What I did with it

- Added a test that pins this down, because it is exactly the kind of mistake that comes back: `parses AUTO_PROCESS=false as false, not as a truthy string`.
- Added the cross-field checks myself (minimum latency must not exceed maximum; decline rate plus error rate must not exceed 1).
- Ran the built service with `PORT=abc` to see the failure for real:

```
Invalid configuration:
  PORT: Invalid input: expected number, received NaN
exit=1
```

---

## 3. Payment model and lifecycle

Commit: `feat: payment model, typed errors and lifecycle state machine`

### Prompt

~~~~text
Payment model and lifecycle next.

- Amount is an integer in minor units. Never a float.
- Statuses: pending, processing, successful, failed. successful and failed are final.
- I want the lifecycle rules in ONE pure function. It takes a payment and a target status and returns a new payment or throws. It must not mutate its input. Nothing else in the codebase is allowed to change a status.
- Keep a status history on the payment: status, time, reason. Append only.
- Typed errors that carry an HTTP status and a stable machine-readable code, so one handler can translate them later.
- Tests: every pair of statuses, allowed and not allowed.
~~~~

### AI reply (summary)

Produced `payment.types.ts`, `payment.state-machine.ts`, `errors.ts` and the tests. The transition table in the draft allowed `pending -> successful` directly, with the comment that it would be convenient for manual updates.

### What I did with it

- **Removed `pending -> successful`.** A payment that never went through processing has not been charged, so it must not be markable as paid in one step. Convenience is not a reason to allow a state that should be impossible. The allowed transitions are now only: `pending -> processing`, `pending -> failed`, `processing -> successful`, `processing -> failed`.
- Checked the "rejects everything else" test really covers all 16 pairs, by reading the loop and not just the green tick.
- Added a separate response type that strips internal fields, so storage details cannot leak through the API by accident.

---

## 4. Storage

Commit: `feat: storage layer with in-memory and JSON file repositories`

### Prompt

~~~~text
Storage. One PaymentRepository interface, two implementations: in-memory and a JSON file.

Requirements:
- The SAME test suite must run against both implementations.
- Callers must never be able to change stored data by holding a reference to it.
- File store: no synchronous fs calls, and the file must never be left half-written.
- If the data file is corrupt at startup, refuse to start. Do not start empty.
~~~~

### AI reply (summary)

Produced the interface, both stores and a shared contract suite using `describe.each`. The stores return copies. The file store queues writes and uses a temp file plus rename. The draft interface had `findById` and `save(payment)`.

### Follow-up prompt

~~~~text
With findById + save: if the background processor and an API request both read the same payment as "pending" and both save, can both succeed?
~~~~

### AI reply (summary)

Yes. Both read `pending`, both pass the lifecycle check, and the second save silently overwrites the first. That is a lost update. Two fixes: a version number with compare-and-set, or an atomic `update(id, mutate)` where the check and the write happen as one step inside the store. Recommended the second as simpler here, and noted it maps to `UPDATE ... WHERE id = $1 AND status = $2` in SQL.

### What I did with it

- Took the atomic `update(id, mutate)`. Replaced `save` entirely so the unsafe pattern is not available.
- Asked for, then read, a test that fires five concurrent transitions at one payment and requires exactly one to win. It passes against both stores.
- Made the idempotency key unique at the storage level, like a database constraint, because I knew I would need it in step 7.

---

## 5. Simulated gateway

Commit: `feat: simulated payment gateway with idempotent charges`

### Prompt

~~~~text
A simulated payment gateway behind a PaymentGateway interface.

- Random latency in a configurable range, then one of: approved, declined, or a transient failure.
- A decline is a business result: RETURN it. An outage is infrastructure: THROW it. I want the caller to be able to tell "do not retry" from "retry".
- It must accept an AbortSignal and stop waiting when aborted.
- The random source must be injectable. I do not want a single test that depends on Math.random.
- Retrying after a timeout must not be able to charge twice. Take an idempotency key per charge and return the original answer if the same key comes back.
- Pass the gateway only what it needs, not the whole payment record.
~~~~

### AI reply (summary)

Produced `payment.gateway.ts` with a `ChargeRequest` of idempotency key, amount and currency, and tests that drive it with a scripted sequence in place of `Math.random`. Remembered results are capped so the simulation cannot grow without limit. Transient errors are deliberately not remembered, since the charge never happened.

### What I did with it

- Checked the idempotency test is a real test: the scripted sequence is arranged so a fresh roll on the retry would have produced a decline. The retry still returns the original approval, so the result is coming from memory and not from luck.
- Confirmed the abort test uses a 60 second latency and finishes instantly.

---

## 6. Background processor

Commit: `feat: background processor with retries, timeouts and recovery`

### Prompt

~~~~text
The background processor. This is the part the side note cares most about, so be careful.

- enqueue(paymentId) never throws and never blocks the caller.
- Claim the payment atomically (pending -> processing). If it is not pending any more, skip it.
- The same payment must never be processed twice at the same time.
- Bounded concurrency: at most N payments at the gateway at once.
- Each gateway call has a timeout. Do not rely on the gateway honouring the abort signal.
- Transient failures: retry with exponential backoff, up to a maximum. Declines: never retry.
- Use the payment id as the gateway idempotency key.
- If someone finalises the payment through the API while the gateway call is in flight, do not crash and do not overwrite their status.
- A way to find and resume unfinished payments nobody is working on, both at startup and on a timer.
- Shutdown: stop taking new work, let in-flight payments finish.
- Inject the sleep function so retry tests run instantly.
~~~~

### AI reply (summary)

Produced `payment.processor.ts` and its tests. Summary of the design: jobs are tracked in a map keyed by payment id (which is what prevents double processing); a small slot counter bounds concurrency; each attempt races the gateway call against a timer; the retry loop converts every outcome into a settlement so it can never throw; settling goes through the same lifecycle function as everything else, so a conflicting manual update is detected there.

### Follow-up prompt

~~~~text
Typecheck fails:

tests/unit/payment.processor.test.ts(33,53): error TS2339: Property 'gatewayReference' does not exist on type 'ChargeResult'.
  Property 'gatewayReference' does not exist on type '{ outcome: "declined"; code: string; message: string; }'.
tests/unit/payment.processor.test.ts(68,86): error TS2339: Property 'message' does not exist on type 'ChargeResult'.
  Property 'message' does not exist on type '{ outcome: "approved"; gatewayReference: string; }'.
~~~~

### AI reply (summary)

The shared test constants were annotated as the union type `ChargeResult`, which throws away which member each one is. Changed them to `as const satisfies ChargeResult`, so each keeps its specific shape while still being checked against the union.

### What I did with it

- Read the retry loop line by line. Checked: the timer is cleared in a `finally`; the timeout rejects before it aborts, so the timeout always wins the race; the slot is released in a `finally`, so a crashed job cannot starve the queue. I asked for a test for that last one specifically.
- Asked "what happens to jobs still waiting for a slot at shutdown?" The draft processed them all, which could hold a shutdown open for a long time. Changed so queued jobs are left `pending` for the next start, and only mid-flight ones are waited for.
- The sweep tests use real timers, so I ran the suite four times in a row to check for flakiness. No failures.
- ts-jest printed a warning on every file (`TS151002 ... hybrid module kind`). Tests passed, but I do not ship warnings I do not understand. Fixed by setting `isolatedModules`.

---

## 7. Service and validation

Commit: `feat: payment service and input validation schemas`

### Prompt

~~~~text
The service layer and the input schemas. The service must know nothing about HTTP.

- createPayment, getPayment, updateStatus.
- Schemas are strict: unknown fields rejected. Every string has a max length, the amount has an upper bound. Currency from a fixed list.
- Create takes an optional idempotency key. Same key + same body returns the original payment. Same key + different body is an error.
- updateStatus with the status the payment already has is a no-op, so a client can retry safely.
~~~~

### AI reply (summary)

Produced `payment.schemas.ts`, `payment.service.ts` and tests. Idempotency in the draft was: look up the key, and if nothing is found, insert.

### Follow-up prompt

~~~~text
Look-up-then-insert has a gap. Ten identical requests with the same key arrive together: all ten look up, all ten find nothing, all ten insert. How many payments do I get?
~~~~

### AI reply (summary)

Up to ten. The check and the insert are separate steps, so the check proves nothing by the time the insert runs. The fix is to stop checking first: always attempt the insert, let the store's uniqueness rule reject the duplicate, and on that specific error fetch and return the existing payment. Also noted that "same body" should not depend on JSON key order, and added a canonical hash of the body for the comparison.

### What I did with it

- Took the insert-first approach. This is why I made the key unique in the store back in step 4.
- Added the test I actually cared about: ten concurrent creates with one key must produce one payment, one "created" result, nine "replayed" results, and one enqueue.
- Chose `422` for a reused key with a different body. `409` would also be defensible; I documented the choice.

---

## 8. HTTP API

Commit: `feat: HTTP API with central error handling, request logging and OpenAPI docs`

### Prompt

~~~~text
Now the HTTP layer on Express 5.

- An app FACTORY that does not listen, so tests can drive the real app in-process with supertest.
- Routes are thin: validate, call the service, shape the response. No business logic.
- ONE error handler. Every error in the same JSON shape: code, message, optional details, request id. Unknown routes and malformed JSON included.
- Anything that is not one of my typed errors is a bug: log it with the stack, return an opaque 500. No internals in the response, ever.
- Every request gets an id (reuse X-Request-Id if the caller sent a safe one), echoed in the response header and in every log line.
- POST returns 201 with a Location header. A malformed id is 400, an unknown id is 404.
- OpenAPI document served with Swagger UI at /docs.
- Integration tests for every status code each endpoint can return.
~~~~

### AI reply (summary)

Produced the routes, middleware, app factory, OpenAPI document and the integration tests.

### Follow-up prompt

~~~~text
Lint fails:

tests/integration/payments.api.test.ts
  254:7  error  Unexpected newline between object and [ of property access  no-unexpected-multiline
~~~~

### AI reply (summary)

A chained call was split so that a line began with `[method]`, which JavaScript can read as indexing the previous line's result. Reformatted so the property access stays on the same line as its object.

### What I did with it

- Started the server and called it by hand, because passing tests only prove what the tests ask. One response was not good enough:

```
{"field":"customerId","message":"Invalid input: expected string, received undefined"}
```

  That is the validation library talking, not my API. I wrote explicit messages for the required fields and re-ran it.
- Tested the 500 path by making the service throw an error containing a fake hostname and password, and asserting neither appears in the response body.
- Put the Swagger UI routes ahead of Helmet: the UI needs a looser content security policy than a JSON API should have, and I did not want to weaken the policy for the whole API to make the docs page work.

---

## 9. Server bootstrap and manual testing

Commit: `feat: server bootstrap with crash recovery and graceful shutdown`

### Prompt

~~~~text
server.ts: the composition root. The only file that chooses concrete implementations.

- On start: resume unfinished payments, then start the recovery sweep.
- SIGTERM / SIGINT: stop accepting connections, let in-flight payments settle, flush storage, exit 0. A hard deadline so it can never hang.
- unhandledRejection / uncaughtException: log as fatal and exit 1.
- If the port is taken, say so clearly and exit 1.
~~~~

### AI reply (summary)

Produced `server.ts`. Noted that in Express 5 the `listen` callback receives the error (for example `EADDRINUSE`) as its argument, so it has to be handled there.

### What I did with it

None of this file is covered by unit tests, so I tested it by hand and kept the output.

**Crash mid-payment.** File storage, gateway latency set to 3 seconds, create a payment, `kill -9` the process, start it again:

```
on disk after crash: processing
after restart: successful ['pending', 'processing', 'successful']
"resumed":1
```

**Shutdown with a payment in flight.** Gateway latency 1.5 seconds, create a payment, send `SIGTERM` immediately. Log order:

```
"msg":"Payment service listening"
"msg":"Payment created"
"msg":"Payment processing started"
"msg":"Request completed"
"msg":"Shutting down"
"msg":"Payment settled"
"msg":"Shutdown complete"
exit=0
```

The payment settles after "Shutting down" and before "Shutdown complete", which is the behaviour I wanted.

**Port in use.** Second instance on the same port logs a fatal `listen EADDRINUSE: address already in use` and exits.

---

## 10. Failure review

Commit: `fix(storage): never acknowledge or keep a payment that was not saved`

Everything passed at this point: 156 tests green and a clean manual run. The side note asks to "identify potential points of failure", so I did a deliberate pass before calling it done.

### Prompt

~~~~text
Act as a reviewer who wants to reject this pull request.

Go through the create path and the processing path. For EVERY await, tell me what state memory, disk and the client are in if that await throws. Do not reassure me. I want the cases where they disagree.
~~~~

### AI reply (summary)

Walked both paths. Most steps were sound: validation fails before any state changes; lifecycle violations write nothing; the processor converts every gateway outcome into a settlement.

**One real defect, in the file store.** `insert` updates the in-memory data first and writes to disk second. If the write throws (disk full, permissions):

- the client gets a `500`, so it believes the payment was not created
- the payment is still in memory, although it was never saved
- the recovery sweep will later find it `pending` and charge it: a charge for a payment the client was told had failed
- retrying the insert is rejected as a duplicate of a payment that does not exist on disk

`update` has the same shape: on a failed write the new status is visible in memory but not on disk, and is lost on restart.

Two further observations, not defects: with in-memory storage a crash loses everything, by definition; and if saving a processing result fails, the payment stays `processing` until the sweep retries it, which is safe only because charges are idempotent.

### What I did with it

**I did not take its word for it.** I wrote the tests first, making the disk write fail by putting a directory where the temp file goes, and ran them against the existing code:

```
● FilePaymentRepository durability › when the disk write fails › rejects the insert and does not keep the payment in memory either

    expect(received).toBeNull()
    Received: {"amount": 250000, ... "idempotencyKey": "key-1", ... "status": "pending", ...}

● FilePaymentRepository durability › when the disk write fails › rejects the update and keeps the previous status

    Expected: "pending"
    Received: "processing"

● FilePaymentRepository durability › when the disk write fails › works again once the disk recovers, and the retry succeeds cleanly

    DuplicateIdempotencyKeyError: A payment with idempotency key "key-1" already exists

Tests:       3 failed, 24 skipped, 27 total
```

Confirmed, all three symptoms. Then the fix:

~~~~text
Fix it so a change only becomes visible after it is on disk. Apply the change to a private copy, write the copy, and only then swap it in. All writes go through one queue. If the write fails, nothing changes.
~~~~

The three tests pass against the new store, and the whole suite is at 159.

**What this taught me:** the code had 156 passing tests and a clean manual run, and still had a data-consistency bug in a payment service. I had accepted that file store in step 4 with the write order as it was. No existing test made a disk write fail, so nothing could have caught it. It was found by asking "what if this step fails?" for each step.

I accepted the in-memory limitation and documented it in the README, since the brief explicitly allows in-memory storage.

---

## 11. Security review

Commit: `feat(security): API key authentication, rate limiting and no-store`

### Prompt

~~~~text
Now review this as an attacker, not as the author. It is a payment API. What would you try, and what is missing? Rank by severity.
~~~~

### AI reply (summary)

1. **No authentication.** Anyone who can reach the service can create payments and change their status.
2. **No rate limiting.** Trivial to flood, and any future credential could be brute-forced.
3. **Metadata keys are unrestricted.** Keys like `__proto__` deserve a check.
4. **Payment responses are cacheable** by intermediaries.

Already in place: strict validation, body size limit, Helmet headers, no stack traces in responses, unguessable ids, redacted logs. For authentication it proposed JWTs with an issuer and a login endpoint.

### What I did with it

**Rejected JWT.** A login flow, token issuing and key management are a project of their own and are not what this assessment is about. API keys are how service-to-service payment APIs are commonly protected, and they fit in one small middleware. I made authentication opt-in through `API_KEYS`: a take-home that needs secrets configured before it answers a request is hostile to reviewers, but a payment API with no authentication available is not credible. It logs a warning at startup while it is off.

**Tested the metadata claim instead of assuming.** I sent `{"__proto__":"x","constructor":"y","ok":"z"}` as metadata through the schema and printed what came out:

```
true [ [ 'constructor', 'ok' ], true, '{"constructor":"y","ok":"z"}' ]
```

So validation passed, `__proto__` was silently dropped, and `constructor` was accepted. Not exploitable as written, but silently changing a client's input is wrong and `constructor` as a key is asking for trouble downstream. Both are now rejected with a clear error.

**Two questions I asked before accepting the middleware:**

~~~~text
1. Is the key comparison constant time? A plain === leaks how many leading characters matched.
2. Which runs first, rate limiting or authentication, and why?
~~~~

Answers, both of which I verified in the code: keys are hashed to fixed-length digests and compared with `timingSafeEqual`, checking every configured key without stopping at the first match. Rate limiting runs first, so guessing keys is throttled too. Both run before the body is parsed.

Checked for real against the running server:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
{"error":{"code":"unauthorized","message":"A valid API key is required","requestId":"..."}}

HTTP/1.1 429 Too Many Requests
RateLimit-Policy: 6;w=60
Retry-After: 59
{"error":{"code":"rate_limited","message":"Too many requests, please slow down and retry later","requestId":"..."}}
```

`npm audit --omit=dev`: `found 0 vulnerabilities`.

---

## 12. README and final verification

Commit: `docs: README with setup, API reference, failure handling and security`

### Prompt

~~~~text
Draft the README: quick start, configuration, how it works, a table of every failure point and what the service does about it, security, full API reference with examples, how to run the tests, project structure, design decisions, and what I would add for production. Write the design decisions from my choices in this conversation, not generic ones.
~~~~

### AI reply (summary)

Produced the README.

### Follow-up prompt

~~~~text
Now check your own work. Go through every factual claim in the README and tell me which ones are not strictly true of the code and tests as they are.
~~~~

### AI reply (summary)

Two overclaims:

1. "Nothing depends on real randomness or wall-clock timing." Not strictly true: two short tests use real timers (the gateway latency test and the processor timeout test).
2. "Each row [of the failure table] has at least one test." Three rows do not have automated tests: port in use, unhandled rejection, and the shutdown deadline. They live in `server.ts` and were verified by hand in step 9.

### What I did with it

Corrected both sentences. A README that overstates the testing is worse than one that is honest about a gap.

## Where I changed or rejected AI output

| Step | AI produced or proposed | What I did | How I knew |
| --- | --- | --- | --- |
| 1 | BullMQ and Redis for the queue | Rejected. In-process queue behind an interface. | The brief asks for simplicity and must run with `npm install` alone. |
| 2 | `z.coerce.boolean()` for an environment flag | Replaced with explicit parsing, added a test. | Asked what it returns for the string `"false"`. |
| 3 | `pending -> successful` allowed "for convenience" | Removed. | An uncharged payment must not be markable as paid. |
| 4 | `findById` + `save` on the repository | Replaced with an atomic `update`. | Asked what happens when two writers read the same status. |
| 6 | Test constants typed too loosely | Fixed with `as const satisfies`. | Typecheck failed. |
| 6 | Queued jobs all processed at shutdown | Changed to leave them `pending`. | Asked what happens to waiting jobs. |
| 6 | A ts-jest warning on every file | Fixed the configuration. | Read the output, not only the pass count. |
| 7 | Look-up-then-insert for idempotency | Replaced with insert-first and a uniqueness rule. | Asked how many payments ten simultaneous requests would create. |
| 8 | A statement that parsed ambiguously | Reformatted. | Lint failed. |
| 8 | Generic library error messages | Wrote explicit messages. | Read the actual response from the running server. |
| 10 | File store changed memory before disk | Rewrote it. Wrote failing tests first. | Deliberate failure review, then reproduced it. |
| 11 | JWT authentication with a login flow | Rejected. Opt-in API keys. | Out of proportion to the task. |
| 11 | Unrestricted metadata keys | Rejected `__proto__` and `constructor` explicitly. | Ran the input through the schema and looked at the result. |
| 12 | Two overclaims in the README | Corrected. | Asked the AI to audit its own claims, then checked them against the tests. |



---

**What I verified myself, without relying on the AI's say-so:** the full test suite from a clean install; every endpoint and every documented error by hand against the running server; a real crash and restart; a real shutdown with work in flight; a real disk-write failure; the gateway failing every call; authentication and rate limiting against the running server; and every commit in the history on its own.
