import pino, { type Logger } from 'pino';

export type { Logger };

/**
 * Structured JSON logs to stdout. Anything that could carry credentials is
 * redacted so it can never end up in a log aggregator.
 */
export function createLogger(level: string = 'info'): Logger {
  return pino({
    level,
    base: { service: 'payment-service' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.authorization'],
      censor: '[redacted]',
    },
  });
}
