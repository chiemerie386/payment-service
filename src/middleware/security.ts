import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { RateLimitedError, UnauthorizedError } from '../errors';

export interface SecurityOptions {
  /** Accepted API keys. Empty means authentication is switched off (local development). */
  apiKeys: readonly string[];
  rateLimit: {
    windowMs: number;
    /** Requests allowed per client per window. 0 switches rate limiting off. */
    max: number;
  };
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Requires `Authorization: Bearer <key>` (or `X-API-Key: <key>`).
 *
 * Keys are compared as fixed-length digests with timingSafeEqual and without
 * stopping at the first match, so response time reveals nothing about how
 * close a guess was or which key matched.
 */
export function requireApiKey(apiKeys: readonly string[]): RequestHandler {
  const acceptedDigests = apiKeys.map(sha256);

  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = extractKey(req);
    let authorised = false;
    if (presented) {
      const presentedDigest = sha256(presented);
      for (const accepted of acceptedDigests) {
        authorised = timingSafeEqual(accepted, presentedDigest) || authorised;
      }
    }

    if (!authorised) {
      res.set('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedError();
    }
    next();
  };
}

function extractKey(req: Request): string | undefined {
  const authorization = req.get('Authorization');
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim() || undefined;
  }
  return req.get('X-API-Key') || undefined;
}

/** Caps requests per client so one caller cannot exhaust the service or brute-force keys. */
export function rateLimiter(options: SecurityOptions['rateLimit']): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new RateLimitedError()),
  });
}

/** Payment data must never sit in a browser or proxy cache. */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.set('Cache-Control', 'no-store');
  next();
}
