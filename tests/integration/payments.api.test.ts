import request from 'supertest';
import { GatewayUnavailableError } from '../../src/payments/payment.gateway';
import { buildTestApp, DECLINED } from '../helpers';

const validBody = {
  amount: 250000,
  currency: 'NGN',
  customerId: 'cus_10293',
  description: 'Order #5521',
  metadata: { orderId: '5521' },
};
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('POST /payments', () => {
  it('creates a pending payment and responds 201 with its location', async () => {
    const { app } = buildTestApp({ autoProcess: false });

    const response = await request(app).post('/payments').send(validBody);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ ...validBody, status: 'pending' });
    expect(response.body.id).toMatch(UUID);
    expect(response.body.statusHistory).toHaveLength(1);
    expect(response.headers.location).toBe(`/payments/${response.body.id}`);
  });

  it('never exposes internal bookkeeping fields', async () => {
    const { app } = buildTestApp({ autoProcess: false });

    const response = await request(app).post('/payments').set('Idempotency-Key', 'key-1').send(validBody);

    expect(response.body).not.toHaveProperty('idempotencyKey');
    expect(response.body).not.toHaveProperty('requestFingerprint');
  });

  it('responds before processing finishes, then the payment becomes successful', async () => {
    const { app, processor } = buildTestApp();

    const created = await request(app).post('/payments').send(validBody);
    expect(created.body.status).toBe('pending');

    await processor.drain();
    const fetched = await request(app).get(`/payments/${created.body.id}`);

    expect(fetched.body.status).toBe('successful');
    expect(fetched.body.gatewayReference).toBe('sim_test_reference');
    expect(fetched.body.statusHistory.map((entry: { status: string }) => entry.status)).toEqual([
      'pending',
      'processing',
      'successful',
    ]);
  });

  it('reports a declined payment as failed with the reason', async () => {
    const { app, gateway, processor } = buildTestApp();
    gateway.charge.mockResolvedValue(DECLINED);

    const created = await request(app).post('/payments').send(validBody);
    await processor.drain();
    const fetched = await request(app).get(`/payments/${created.body.id}`);

    expect(fetched.status).toBe(200);
    expect(fetched.body.status).toBe('failed');
    expect(fetched.body.failure).toEqual({ code: 'insufficient_funds', message: DECLINED.message });
  });

  it('reports a gateway outage as a failed payment, not as a crashed request', async () => {
    const { app, gateway, processor } = buildTestApp();
    gateway.charge.mockRejectedValue(new GatewayUnavailableError());

    const created = await request(app).post('/payments').send(validBody);
    await processor.drain();
    const fetched = await request(app).get(`/payments/${created.body.id}`);

    expect(created.status).toBe(201);
    expect(fetched.body.status).toBe('failed');
    expect(fetched.body.failure.code).toBe('gateway_unavailable');
  });

  it.each([
    ['missing amount', { ...validBody, amount: undefined }, 'amount'],
    ['zero amount', { ...validBody, amount: 0 }, 'amount'],
    ['negative amount', { ...validBody, amount: -100 }, 'amount'],
    ['fractional amount', { ...validBody, amount: 10.5 }, 'amount'],
    ['amount sent as a string', { ...validBody, amount: '250000' }, 'amount'],
    ['amount above the limit', { ...validBody, amount: 1e15 }, 'amount'],
    ['unsupported currency', { ...validBody, currency: 'XXX' }, 'currency'],
    ['lower case currency', { ...validBody, currency: 'ngn' }, 'currency'],
    ['missing customerId', { ...validBody, customerId: undefined }, 'customerId'],
    ['blank customerId', { ...validBody, customerId: '   ' }, 'customerId'],
    ['non-string metadata value', { ...validBody, metadata: { orderId: 5521 } }, 'metadata.orderId'],
    ['metadata key with unsafe characters', { ...validBody, metadata: { '<script>': 'x' } }, 'metadata.<script>'],
    ['metadata key "constructor"', { ...validBody, metadata: { constructor: 'x' } }, 'metadata'],
    ['too many metadata keys', { ...validBody, metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])) }, 'metadata'],
    ['client-supplied status', { ...validBody, status: 'successful' }, 'body'],
  ])('rejects %s with 400 and names the field', async (_case, body, field) => {
    const { app, repository } = buildTestApp({ autoProcess: false });

    const response = await request(app).post('/payments').send(body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field })]),
    );
    expect(repository.snapshot()).toHaveLength(0);
  });

  it('rejects a __proto__ metadata key instead of silently dropping it', async () => {
    const { app } = buildTestApp({ autoProcess: false });

    // Sent as raw text: building this object in JavaScript would set the prototype instead.
    const response = await request(app)
      .post('/payments')
      .set('Content-Type', 'application/json')
      .send('{"amount":100,"currency":"NGN","customerId":"c1","metadata":{"__proto__":{"admin":"true"}}}');

    expect(response.status).toBe(400);
    expect(response.body.error.details[0].field).toBe('metadata');
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('rejects malformed JSON with 400', async () => {
    const { app } = buildTestApp();

    const response = await request(app)
      .post('/payments')
      .set('Content-Type', 'application/json')
      .send('{"amount": 100,');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_json');
  });

  it('rejects a missing body with 400', async () => {
    const { app } = buildTestApp();

    const response = await request(app).post('/payments');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
  });

  it('rejects an oversized body with 413', async () => {
    const { app } = buildTestApp();

    const response = await request(app)
      .post('/payments')
      .send({ ...validBody, description: 'x'.repeat(20_000) });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('payload_too_large');
  });

  describe('idempotency', () => {
    it('returns the original payment when a request is retried with the same key', async () => {
      const { app, repository } = buildTestApp({ autoProcess: false });

      const first = await request(app).post('/payments').set('Idempotency-Key', 'key-1').send(validBody);
      const retry = await request(app).post('/payments').set('Idempotency-Key', 'key-1').send(validBody);

      expect(first.status).toBe(201);
      expect(retry.status).toBe(200);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body.id).toBe(first.body.id);
      expect(repository.snapshot()).toHaveLength(1);
    });

    it('rejects a key that is reused with a different body with 422', async () => {
      const { app } = buildTestApp({ autoProcess: false });
      await request(app).post('/payments').set('Idempotency-Key', 'key-1').send(validBody);

      const response = await request(app)
        .post('/payments')
        .set('Idempotency-Key', 'key-1')
        .send({ ...validBody, amount: 1 });

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('idempotency_key_reused');
    });

    it('rejects an invalid Idempotency-Key header with 400', async () => {
      const { app } = buildTestApp({ autoProcess: false });

      const response = await request(app)
        .post('/payments')
        .set('Idempotency-Key', 'has spaces in it')
        .send(validBody);

      expect(response.status).toBe(400);
      expect(response.body.error.details[0].field).toBe('Idempotency-Key');
    });

    it('charges only once when the same request is sent concurrently', async () => {
      const { app, gateway, processor, repository } = buildTestApp();

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app).post('/payments').set('Idempotency-Key', 'key-1').send(validBody),
        ),
      );
      await processor.drain();

      expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
      expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
      expect(repository.snapshot()).toHaveLength(1);
      expect(gateway.charge).toHaveBeenCalledTimes(1);
    });
  });
});

describe('GET /payments/:id', () => {
  it('returns the payment', async () => {
    const { app } = buildTestApp({ autoProcess: false });
    const created = await request(app).post('/payments').send(validBody);

    const response = await request(app).get(`/payments/${created.body.id}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(created.body);
  });

  it('responds 404 for an id that does not exist', async () => {
    const { app } = buildTestApp();

    const response = await request(app).get(`/payments/${UNKNOWN_ID}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({
      code: 'payment_not_found',
      message: `Payment ${UNKNOWN_ID} was not found`,
    });
  });

  it('responds 400 for an id that is not a UUID', async () => {
    const { app } = buildTestApp();

    const response = await request(app).get('/payments/not-a-uuid');

    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([{ field: 'id', message: 'id must be a valid UUID' }]);
  });
});

describe.each(['patch', 'put'] as const)('%s /payments/:id', (method) => {
  it('moves a payment through the lifecycle', async () => {
    const { app } = buildTestApp({ autoProcess: false });
    const created = await request(app).post('/payments').send(validBody);
    const url = `/payments/${created.body.id}`;

    const processing = await request(app)[method](url).send({ status: 'processing' });
    const successful = await request(app)[method](url).send({ status: 'successful', reason: 'Confirmed by bank' });

    expect(processing.status).toBe(200);
    expect(processing.body.status).toBe('processing');
    expect(successful.status).toBe(200);
    expect(successful.body.status).toBe('successful');
    expect(successful.body.statusHistory.at(-1)).toMatchObject({
      status: 'successful',
      reason: 'Confirmed by bank',
    });
    expect((await request(app).get(url)).body).toEqual(successful.body);
  });

  it('records why a payment was failed', async () => {
    const { app } = buildTestApp({ autoProcess: false });
    const created = await request(app).post('/payments').send(validBody);

    const response = await request(app)[method](`/payments/${created.body.id}`).send({
      status: 'failed',
      reason: 'Cancelled by customer',
    });

    expect(response.status).toBe(200);
    expect(response.body.failure).toEqual({ code: 'manually_failed', message: 'Cancelled by customer' });
  });

  it('responds 409 for a transition the lifecycle does not allow', async () => {
    const { app } = buildTestApp({ autoProcess: false });
    const created = await request(app).post('/payments').send(validBody);

    const response = await request(app)[method](`/payments/${created.body.id}`).send({ status: 'successful' });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
      code: 'invalid_status_transition',
      details: { from: 'pending', to: 'successful', allowed: ['processing', 'failed'] },
    });
  });

  it('responds 409 when trying to change a payment that already finished', async () => {
    const { app, processor } = buildTestApp();
    const created = await request(app).post('/payments').send(validBody);
    await processor.drain();

    const response = await request(app)[method](`/payments/${created.body.id}`).send({ status: 'failed' });

    expect(response.status).toBe(409);
    expect((await request(app).get(`/payments/${created.body.id}`)).body.status).toBe('successful');
  });

  it('is idempotent when the same status is sent twice', async () => {
    const { app } = buildTestApp({ autoProcess: false });
    const created = await request(app).post('/payments').send(validBody);
    const url = `/payments/${created.body.id}`;

    const first = await request(app)[method](url).send({ status: 'processing' });
    const second = await request(app)[method](url).send({ status: 'processing' });

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it.each([
    ['an unknown status', { status: 'refunded' }],
    ['a transition back to pending', { status: 'pending' }],
    ['a missing status', {}],
    ['an attempt to change other fields', { status: 'processing', amount: 1 }],
  ])('responds 400 for %s', async (_case, body) => {
    const { app } = buildTestApp({ autoProcess: false });
    const created = await request(app).post('/payments').send(validBody);

    const response = await request(app)[method](`/payments/${created.body.id}`).send(body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
  });

  it('responds 404 for an id that does not exist', async () => {
    const { app } = buildTestApp();

    const response = await request(app)[method](`/payments/${UNKNOWN_ID}`).send({ status: 'processing' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('payment_not_found');
  });
});

describe('cross-cutting behaviour', () => {
  it('returns a generic 500 without leaking internals when something unexpected breaks', async () => {
    const { app, paymentService } = buildTestApp();
    jest
      .spyOn(paymentService, 'getPayment')
      .mockRejectedValue(new Error('connection to db-prod-1 refused, password=hunter2'));

    const response = await request(app).get(`/payments/${UNKNOWN_ID}`);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred',
        requestId: expect.any(String),
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
  });

  it('responds 404 in the standard error shape for unknown routes', async () => {
    const { app } = buildTestApp();

    const response = await request(app).delete('/payments');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('route_not_found');
  });

  it('generates a request id and includes it in headers and error bodies', async () => {
    const { app } = buildTestApp();

    const response = await request(app).get(`/payments/${UNKNOWN_ID}`);

    expect(response.headers['x-request-id']).toMatch(UUID);
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('reuses a safe request id supplied by the caller', async () => {
    const { app } = buildTestApp();

    const response = await request(app).get('/health').set('X-Request-Id', 'trace-abc.123');

    expect(response.headers['x-request-id']).toBe('trace-abc.123');
  });

  it('replaces an unsafe caller-supplied request id', async () => {
    const { app } = buildTestApp();

    const response = await request(app).get('/health').set('X-Request-Id', '<script>alert(1)</script>');

    expect(response.headers['x-request-id']).toMatch(UUID);
  });

  it('does not advertise the framework', async () => {
    const { app } = buildTestApp();

    const response = await request(app).get('/health');

    expect(response.headers).not.toHaveProperty('x-powered-by');
  });

  it('exposes a health check', async () => {
    const { app } = buildTestApp();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', uptimeSeconds: expect.any(Number) });
  });

  it('serves the OpenAPI document and Swagger UI', async () => {
    const { app } = buildTestApp();

    const spec = await request(app).get('/openapi.json');
    const ui = await request(app).get('/docs/');

    expect(spec.status).toBe(200);
    expect(Object.keys(spec.body.paths)).toEqual(['/payments', '/payments/{id}', '/health']);
    expect(ui.status).toBe(200);
    expect(ui.text).toContain('swagger-ui');
  });
});
