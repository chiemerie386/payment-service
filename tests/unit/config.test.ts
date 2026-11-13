import { loadConfig } from '../../src/config';

describe('loadConfig', () => {
  it('falls back to sensible defaults', () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      env: 'development',
      port: 3000,
      persistence: 'memory',
      autoProcess: true,
      processing: { maxAttempts: 3, maxConcurrency: 10 },
      recoverySweepIntervalMs: 30_000,
    });
  });

  it('reads and coerces values from the environment', () => {
    const config = loadConfig({
      PORT: '8080',
      PERSISTENCE: 'file',
      DATA_FILE: '/tmp/payments.json',
      GATEWAY_DECLINE_RATE: '0.5',
      PROCESSING_MAX_ATTEMPTS: '5',
    });

    expect(config.port).toBe(8080);
    expect(config.persistence).toBe('file');
    expect(config.dataFile).toBe('/tmp/payments.json');
    expect(config.gateway.declineRate).toBe(0.5);
    expect(config.processing.maxAttempts).toBe(5);
  });

  it('parses AUTO_PROCESS=false as false, not as a truthy string', () => {
    expect(loadConfig({ AUTO_PROCESS: 'false' }).autoProcess).toBe(false);
    expect(loadConfig({ AUTO_PROCESS: 'true' }).autoProcess).toBe(true);
  });

  it.each([
    [{ PROCESSING_MAX_CONCURRENCY: '0' }, /PROCESSING_MAX_CONCURRENCY/],
    [{ PORT: 'abc' }, /PORT/],
    [{ PERSISTENCE: 'redis' }, /PERSISTENCE/],
    [{ AUTO_PROCESS: 'yes' }, /AUTO_PROCESS/],
    [{ GATEWAY_DECLINE_RATE: '1.5' }, /GATEWAY_DECLINE_RATE/],
    [{ GATEWAY_MIN_LATENCY_MS: '500', GATEWAY_MAX_LATENCY_MS: '100' }, /GATEWAY_MIN_LATENCY_MS/],
    [{ GATEWAY_DECLINE_RATE: '0.7', GATEWAY_ERROR_RATE: '0.7' }, /must not exceed 1/],
  ])('fails fast on invalid configuration %j', (env, expected) => {
    expect(() => loadConfig(env)).toThrow(expected);
  });
});
