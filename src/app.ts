import express, { type Express } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { openApiDocument } from './docs/openapi';
import type { Logger } from './logger';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestContext } from './middleware/request-context';
import { createPaymentRouter } from './payments/payment.routes';
import type { PaymentService } from './payments/payment.service';

export interface AppDependencies {
  paymentService: PaymentService;
  logger: Logger;
}

/**
 * Builds the Express app without starting a server, so tests can exercise the
 * full HTTP stack in-process with whatever dependencies they choose.
 */
export function createApp({ paymentService, logger }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestContext(logger));

  // Mounted ahead of helmet: Swagger UI needs a looser content security policy
  // than the JSON API should have.
  app.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use(helmet());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  app.use(express.json({ limit: '10kb' }));
  app.use('/payments', createPaymentRouter(paymentService));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
