import { Router, type Request, type Response } from 'express';
import {
  createPaymentSchema,
  idempotencyKeySchema,
  parseOrThrow,
  paymentIdSchema,
  updatePaymentStatusSchema,
} from './payment.schemas';
import type { PaymentService } from './payment.service';
import { toPaymentResponse } from './payment.types';

/**
 * HTTP adapter: validate input, call the service, shape the response.
 * Express 5 forwards rejected promises from async handlers to the error
 * middleware, so no try/catch wrappers are needed here.
 */
export function createPaymentRouter(service: PaymentService): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const input = parseOrThrow(createPaymentSchema, req.body);
    const rawKey = req.get('Idempotency-Key');
    const idempotencyKey =
      rawKey === undefined ? undefined : parseOrThrow(idempotencyKeySchema, rawKey, 'Idempotency-Key');

    const { payment, replayed } = await service.createPayment(input, idempotencyKey);

    if (replayed) {
      res.set('Idempotent-Replayed', 'true');
    }
    res
      .status(replayed ? 200 : 201)
      .location(`${req.baseUrl}/${payment.id}`)
      .json(toPaymentResponse(payment));
  });

  router.get('/:id', async (req: Request, res: Response) => {
    const { id } = parseOrThrow(paymentIdSchema, req.params);
    res.json(toPaymentResponse(await service.getPayment(id)));
  });

  const updateStatus = async (req: Request, res: Response) => {
    const { id } = parseOrThrow(paymentIdSchema, req.params);
    const input = parseOrThrow(updatePaymentStatusSchema, req.body);
    res.json(toPaymentResponse(await service.updateStatus(id, input)));
  };

  // PATCH is the natural verb for a partial update. PUT is accepted as an
  // alias because the brief allows either.
  router.patch('/:id', updateStatus);
  router.put('/:id', updateStatus);

  return router;
}
