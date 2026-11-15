import { z } from 'zod';

/**
 * Environment variables are strings, and z.coerce.boolean() would turn the
 * string "false" into true, so booleans are parsed explicitly.
 */
const booleanFromEnv = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const rate = z.coerce.number().min(0).max(1);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    PERSISTENCE: z.enum(['memory', 'file']).default('memory'),
    DATA_FILE: z.string().min(1).default('./data/payments.json'),

    AUTO_PROCESS: booleanFromEnv.default(true),

    GATEWAY_MIN_LATENCY_MS: z.coerce.number().int().min(0).default(200),
    GATEWAY_MAX_LATENCY_MS: z.coerce.number().int().min(0).default(1200),
    GATEWAY_DECLINE_RATE: rate.default(0.2),
    GATEWAY_ERROR_RATE: rate.default(0.1),

    PROCESSING_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
    PROCESSING_BACKOFF_MS: z.coerce.number().int().min(0).default(200),
    PROCESSING_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().min(1).default(5000),
    PROCESSING_MAX_CONCURRENCY: z.coerce.number().int().min(1).default(10),
    RECOVERY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),

    // Comma-separated. Empty or unset disables authentication.
    API_KEYS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((key) => key.trim())
          .filter((key) => key.length > 0),
      )
      .refine((keys) => keys.every((key) => key.length >= 16), {
        message: 'every API key must be at least 16 characters long',
      }),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(120),

    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
  })
  .refine((env) => env.GATEWAY_MIN_LATENCY_MS <= env.GATEWAY_MAX_LATENCY_MS, {
    message: 'GATEWAY_MIN_LATENCY_MS must not exceed GATEWAY_MAX_LATENCY_MS',
    path: ['GATEWAY_MIN_LATENCY_MS'],
  })
  .refine((env) => env.GATEWAY_DECLINE_RATE + env.GATEWAY_ERROR_RATE <= 1, {
    message: 'GATEWAY_DECLINE_RATE + GATEWAY_ERROR_RATE must not exceed 1',
    path: ['GATEWAY_DECLINE_RATE'],
  });

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  logLevel: string;
  persistence: 'memory' | 'file';
  dataFile: string;
  autoProcess: boolean;
  gateway: {
    minLatencyMs: number;
    maxLatencyMs: number;
    declineRate: number;
    errorRate: number;
  };
  processing: {
    maxAttempts: number;
    baseBackoffMs: number;
    attemptTimeoutMs: number;
    maxConcurrency: number;
  };
  recoverySweepIntervalMs: number;
  security: {
    apiKeys: string[];
    rateLimit: { windowMs: number; max: number };
  };
  shutdownTimeoutMs: number;
}

/**
 * Validates configuration once at startup so a bad value fails fast with a
 * readable message instead of surfacing later as odd runtime behaviour.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }

  const env = parsed.data;
  return {
    env: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    persistence: env.PERSISTENCE,
    dataFile: env.DATA_FILE,
    autoProcess: env.AUTO_PROCESS,
    gateway: {
      minLatencyMs: env.GATEWAY_MIN_LATENCY_MS,
      maxLatencyMs: env.GATEWAY_MAX_LATENCY_MS,
      declineRate: env.GATEWAY_DECLINE_RATE,
      errorRate: env.GATEWAY_ERROR_RATE,
    },
    processing: {
      maxAttempts: env.PROCESSING_MAX_ATTEMPTS,
      baseBackoffMs: env.PROCESSING_BACKOFF_MS,
      attemptTimeoutMs: env.PROCESSING_ATTEMPT_TIMEOUT_MS,
      maxConcurrency: env.PROCESSING_MAX_CONCURRENCY,
    },
    recoverySweepIntervalMs: env.RECOVERY_SWEEP_INTERVAL_MS,
    security: {
      apiKeys: env.API_KEYS,
      rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX },
    },
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  };
}
