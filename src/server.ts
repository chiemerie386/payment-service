import { createApp } from './app';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { FilePaymentRepository } from './payments/file-payment.repository';
import { SimulatedPaymentGateway } from './payments/payment.gateway';
import { PaymentProcessor, type PaymentQueue } from './payments/payment.processor';
import { InMemoryPaymentRepository, type PaymentRepository } from './payments/payment.repository';
import { PaymentService } from './payments/payment.service';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  // A bug that escapes every handler leaves the process in an unknown state:
  // log it and exit so the supervisor (Docker, systemd, k8s) restarts cleanly.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    process.exit(1);
  });

  // Composition root: the only place that knows which concrete classes are in use.
  const fileRepository =
    config.persistence === 'file' ? await FilePaymentRepository.open(config.dataFile) : null;
  const repository: PaymentRepository = fileRepository ?? new InMemoryPaymentRepository();
  const gateway = new SimulatedPaymentGateway(config.gateway);
  const processor = new PaymentProcessor(repository, gateway, logger, config.processing);

  const manualQueue: PaymentQueue = { enqueue: () => undefined };
  const paymentService = new PaymentService(
    repository,
    config.autoProcess ? processor : manualQueue,
    logger,
  );

  if (config.autoProcess) {
    const resumed = await processor.recoverInterrupted();
    if (resumed > 0) {
      logger.info({ resumed }, 'Resumed payments left unfinished by the previous run');
    }
    processor.startRecoverySweep(config.recoverySweepIntervalMs);
  }

  const app = createApp({ paymentService, logger });
  const server = app.listen(config.port, (error?: Error) => {
    if (error) {
      // For example EADDRINUSE: nothing useful can happen without a port.
      logger.fatal({ err: error }, 'Could not start HTTP server');
      process.exit(1);
    }
    logger.info(
      { port: config.port, persistence: config.persistence, autoProcess: config.autoProcess },
      'Payment service listening',
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    // Never hang forever: if draining takes too long, exit anyway.
    const forceExit = setTimeout(() => {
      logger.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
      await processor.shutdown(); // let in-flight payments settle
      await fileRepository?.flush();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // Logger may not exist yet (for example when configuration is invalid).
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
