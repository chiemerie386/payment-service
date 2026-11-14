import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '../logger';

declare module 'express-serve-static-core' {
  interface Request {
    /** Correlation id: taken from X-Request-Id when the caller sends one, generated otherwise. */
    id: string;
    /** Logger that stamps every line with the request id. */
    log: Logger;
  }
}

const SAFE_REQUEST_ID = /^[\w.-]{1,128}$/;

/**
 * Gives every request a correlation id and a child logger, echoes the id back
 * in the X-Request-Id header, and writes one access log line per request.
 */
export function requestContext(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.get('X-Request-Id');
    // Only trust caller ids that are safe to log and reflect in a header.
    req.id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    req.log = logger.child({ requestId: req.id });
    res.set('X-Request-Id', req.id);

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      req.log[level](
        {
          method: req.method,
          path: req.originalUrl,
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
        },
        'Request completed',
      );
    });

    next();
  };
}
