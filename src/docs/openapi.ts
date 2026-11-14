import { MAX_AMOUNT_MINOR_UNITS, SUPPORTED_CURRENCIES } from '../payments/payment.schemas';
import { PAYMENT_STATUSES } from '../payments/payment.types';

const errorResponse = (description: string, code: string, message: string, details?: unknown) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
      example: {
        error: {
          code,
          message,
          ...(details !== undefined && { details }),
          requestId: '3f2b1c9e-8a7d-4e6f-9b0a-1c2d3e4f5a6b',
        },
      },
    },
  },
});

const examplePayment = {
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  amount: 250000,
  currency: 'NGN',
  customerId: 'cus_10293',
  description: 'Order #5521',
  metadata: { orderId: '5521' },
  status: 'pending',
  statusHistory: [{ status: 'pending', at: '2026-01-15T09:30:00.000Z', reason: 'Payment created' }],
  createdAt: '2026-01-15T09:30:00.000Z',
  updatedAt: '2026-01-15T09:30:00.000Z',
};

const paymentIdParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Payment identifier (UUID).',
  schema: { type: 'string', format: 'uuid' },
};

/** OpenAPI 3.0 description of the API. Served at /openapi.json and rendered at /docs. */
export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Payment Processing Simulation API',
    version: '1.0.0',
    description:
      'Creates payments, processes them asynchronously against a simulated gateway, and exposes their status.\n\n' +
      'Lifecycle: `pending` -> `processing` -> `successful` | `failed`. ' +
      '`successful` and `failed` are terminal.',
  },
  tags: [{ name: 'Payments' }, { name: 'Operations' }],
  paths: {
    '/payments': {
      post: {
        tags: ['Payments'],
        summary: 'Create a payment',
        description:
          'Stores the payment as `pending` and returns immediately. Processing happens in the background; ' +
          'poll `GET /payments/{id}` for the outcome.',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            description:
              'Unique key for this create request. Retrying with the same key and body returns the ' +
              'original payment instead of creating a second one.',
            schema: { type: 'string', minLength: 1, maxLength: 255 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreatePaymentRequest' },
              example: {
                amount: 250000,
                currency: 'NGN',
                customerId: 'cus_10293',
                description: 'Order #5521',
                metadata: { orderId: '5521' },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Payment created and queued for processing.',
            headers: {
              Location: { description: 'URL of the new payment.', schema: { type: 'string' } },
            },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Payment' },
                example: examplePayment,
              },
            },
          },
          200: {
            description:
              'Idempotent replay: a payment already exists for this Idempotency-Key. ' +
              'The response carries `Idempotent-Replayed: true`.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Payment' } } },
          },
          400: errorResponse('Invalid input or malformed JSON.', 'validation_error', 'Request validation failed', [
            { field: 'amount', message: 'amount must be greater than zero' },
          ]),
          413: errorResponse('Request body larger than 10kb.', 'payload_too_large', 'Request body is too large'),
          422: errorResponse(
            'The Idempotency-Key was already used with a different body.',
            'idempotency_key_reused',
            'This Idempotency-Key was already used with a different request body',
          ),
          500: { $ref: '#/components/responses/InternalError' },
        },
      },
    },
    '/payments/{id}': {
      get: {
        tags: ['Payments'],
        summary: 'Retrieve a payment',
        parameters: [paymentIdParameter],
        responses: {
          200: {
            description: 'The payment.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Payment' },
                example: examplePayment,
              },
            },
          },
          400: errorResponse('The id is not a UUID.', 'validation_error', 'Request validation failed', [
            { field: 'id', message: 'id must be a valid UUID' },
          ]),
          404: { $ref: '#/components/responses/PaymentNotFound' },
          500: { $ref: '#/components/responses/InternalError' },
        },
      },
      patch: {
        tags: ['Payments'],
        summary: 'Update the status of a payment',
        description:
          'Moves the payment to a new status if the lifecycle allows it. Sending the status the payment ' +
          'already has is a no-op that returns 200. `PUT` on the same path behaves identically.',
        parameters: [paymentIdParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UpdatePaymentStatusRequest' },
              example: { status: 'failed', reason: 'Cancelled by customer' },
            },
          },
        },
        responses: {
          200: {
            description: 'The updated payment.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Payment' } } },
          },
          400: errorResponse('Invalid input or malformed JSON.', 'validation_error', 'Request validation failed', [
            { field: 'status', message: 'status must be one of: processing, successful, failed' },
          ]),
          404: { $ref: '#/components/responses/PaymentNotFound' },
          409: errorResponse(
            'The lifecycle does not allow this transition.',
            'invalid_status_transition',
            'A payment cannot move from "successful" to "failed"',
            { from: 'successful', to: 'failed', allowed: [] },
          ),
          500: { $ref: '#/components/responses/InternalError' },
        },
      },
    },
    '/health': {
      get: {
        tags: ['Operations'],
        summary: 'Liveness check',
        responses: {
          200: {
            description: 'The service is up.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { status: { type: 'string' }, uptimeSeconds: { type: 'integer' } },
                },
                example: { status: 'ok', uptimeSeconds: 42 },
              },
            },
          },
        },
      },
    },
  },
  components: {
    responses: {
      PaymentNotFound: errorResponse(
        'No payment has this id.',
        'payment_not_found',
        'Payment 7c9e6679-7425-40de-944b-e07fc1f90ae7 was not found',
      ),
      InternalError: errorResponse('Unexpected server error.', 'internal_error', 'An unexpected error occurred'),
    },
    schemas: {
      CreatePaymentRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['amount', 'currency', 'customerId'],
        properties: {
          amount: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_AMOUNT_MINOR_UNITS,
            description: 'Amount in the minor currency unit (kobo, cents). 250000 = NGN 2,500.00.',
          },
          currency: { type: 'string', enum: [...SUPPORTED_CURRENCIES] },
          customerId: { type: 'string', minLength: 1, maxLength: 64 },
          description: { type: 'string', maxLength: 255 },
          metadata: {
            type: 'object',
            additionalProperties: { type: 'string', maxLength: 255 },
            maxProperties: 20,
            description: 'Up to 20 string key/value pairs for your own reference.',
          },
        },
      },
      UpdatePaymentStatusRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['processing', 'successful', 'failed'] },
          reason: { type: 'string', minLength: 1, maxLength: 255, description: 'Recorded in the status history.' },
        },
      },
      Payment: {
        type: 'object',
        required: ['id', 'amount', 'currency', 'customerId', 'status', 'statusHistory', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          amount: { type: 'integer' },
          currency: { type: 'string', enum: [...SUPPORTED_CURRENCIES] },
          customerId: { type: 'string' },
          description: { type: 'string' },
          metadata: { type: 'object', additionalProperties: { type: 'string' } },
          status: { type: 'string', enum: [...PAYMENT_STATUSES] },
          failure: {
            type: 'object',
            description: 'Present only when status is `failed`.',
            required: ['code', 'message'],
            properties: {
              code: {
                type: 'string',
                description:
                  'One of: insufficient_funds, card_declined, expired_card, gateway_unavailable, ' +
                  'gateway_timeout, processing_error, manually_failed.',
              },
              message: { type: 'string' },
            },
          },
          gatewayReference: { type: 'string', description: 'Present once the gateway approved the charge.' },
          statusHistory: {
            type: 'array',
            items: {
              type: 'object',
              required: ['status', 'at', 'reason'],
              properties: {
                status: { type: 'string', enum: [...PAYMENT_STATUSES] },
                at: { type: 'string', format: 'date-time' },
                reason: { type: 'string' },
              },
            },
          },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'requestId'],
            properties: {
              code: { type: 'string', description: 'Stable machine-readable error code.' },
              message: { type: 'string' },
              details: { description: 'Extra context, e.g. the list of invalid fields.' },
              requestId: { type: 'string', description: 'Quote this when reporting a problem.' },
            },
          },
        },
      },
    },
  },
} as const;
