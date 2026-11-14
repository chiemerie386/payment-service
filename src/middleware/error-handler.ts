import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

/** Catch-all for routes that do not exist, so they get the same JSON error shape. */
export function notFoundHandler(req: Request, res: Response<ErrorBody>): void {
  res.status(404).json({
    error: {
      code: 'route_not_found',
      message: `No route matches ${req.method} ${req.path}`,
      requestId: req.id,
    },
  });
}

/** Errors raised by Express' own body parser (they carry a status and a type). */
interface HttpLikeError {
  status: number;
  type?: string;
}

function isClientHttpError(error: unknown): error is HttpLikeError {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

const BODY_PARSER_ERRORS: Record<string, { code: string; message: string }> = {
  'entity.parse.failed': { code: 'invalid_json', message: 'Request body is not valid JSON' },
  'entity.too.large': { code: 'payload_too_large', message: 'Request body is too large' },
};

/**
 * The one place where errors become HTTP responses.
 *  - AppError: an expected failure, returned with its own status and code.
 *  - Body parser errors: malformed or oversized input, returned as 4xx.
 *  - Anything else: a bug. Logged in full, returned as an opaque 500 so no
 *    stack trace or internal detail ever reaches the client.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response<ErrorBody>,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined && { details: error.details }),
        requestId: req.id,
      },
    });
    return;
  }

  if (isClientHttpError(error)) {
    const known = error.type ? BODY_PARSER_ERRORS[error.type] : undefined;
    res.status(error.status).json({
      error: {
        code: known?.code ?? 'bad_request',
        message: known?.message ?? 'The request could not be processed',
        requestId: req.id,
      },
    });
    return;
  }

  req.log.error({ err: error }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'An unexpected error occurred',
      requestId: req.id,
    },
  });
}
