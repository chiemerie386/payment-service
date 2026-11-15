import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DuplicateIdempotencyKeyError } from '../../src/errors';
import { FilePaymentRepository } from '../../src/payments/file-payment.repository';
import { InMemoryPaymentRepository, type PaymentRepository } from '../../src/payments/payment.repository';
import { applyTransition } from '../../src/payments/payment.state-machine';
import { buildPayment } from '../helpers';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'payments-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const implementations: Array<[string, () => Promise<PaymentRepository>]> = [
  ['InMemoryPaymentRepository', async () => new InMemoryPaymentRepository()],
  ['FilePaymentRepository', () => FilePaymentRepository.open(path.join(directory, 'payments.json'))],
];

// The same contract must hold for every storage implementation.
describe.each(implementations)('%s', (_name, create) => {
  let repository: PaymentRepository;

  beforeEach(async () => {
    repository = await create();
  });

  it('stores and retrieves a payment by id', async () => {
    const payment = buildPayment();

    await repository.insert(payment);

    expect(await repository.findById(payment.id)).toEqual(payment);
  });

  it('returns null for an unknown id', async () => {
    expect(await repository.findById('missing')).toBeNull();
  });

  it('hands out copies so callers cannot corrupt stored state', async () => {
    const payment = buildPayment();
    await repository.insert(payment);

    payment.status = 'successful';
    const fetched = await repository.findById(payment.id);
    if (fetched) {
      fetched.amount = 1;
      fetched.statusHistory.push({ status: 'failed', at: 'now', reason: 'tampered' });
    }

    const stored = await repository.findById(payment.id);
    expect(stored?.status).toBe('pending');
    expect(stored?.amount).toBe(250000);
    expect(stored?.statusHistory).toHaveLength(1);
  });

  it('finds a payment by idempotency key', async () => {
    const payment = buildPayment({ idempotencyKey: 'key-1' });
    await repository.insert(payment);

    expect(await repository.findByIdempotencyKey('key-1')).toEqual(payment);
    expect(await repository.findByIdempotencyKey('other')).toBeNull();
  });

  it('enforces idempotency key uniqueness', async () => {
    await repository.insert(buildPayment({ id: 'a', idempotencyKey: 'key-1' }));

    await expect(repository.insert(buildPayment({ id: 'b', idempotencyKey: 'key-1' }))).rejects.toThrow(
      DuplicateIdempotencyKeyError,
    );
    expect(await repository.findById('b')).toBeNull();
  });

  it('filters by status', async () => {
    await repository.insert(buildPayment({ id: 'a', status: 'pending' }));
    await repository.insert(buildPayment({ id: 'b', status: 'processing' }));
    await repository.insert(buildPayment({ id: 'c', status: 'successful' }));

    const found = await repository.findByStatus(['pending', 'processing']);

    expect(found.map((payment) => payment.id).sort()).toEqual(['a', 'b']);
  });

  it('applies an update and returns the new version', async () => {
    const payment = buildPayment();
    await repository.insert(payment);

    const updated = await repository.update(payment.id, (current) =>
      applyTransition(current, 'processing', { reason: 'Processing started' }),
    );

    expect(updated?.status).toBe('processing');
    expect((await repository.findById(payment.id))?.status).toBe('processing');
  });

  it('returns null when updating an unknown id', async () => {
    const mutate = jest.fn();

    expect(await repository.update('missing', mutate)).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('writes nothing when the mutator throws', async () => {
    const payment = buildPayment();
    await repository.insert(payment);

    await expect(
      repository.update(payment.id, () => {
        throw new Error('rule violated');
      }),
    ).rejects.toThrow('rule violated');

    expect(await repository.findById(payment.id)).toEqual(payment);
  });

  it('lets exactly one of several concurrent transitions win', async () => {
    const payment = buildPayment();
    await repository.insert(payment);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        repository.update(payment.id, (current) =>
          applyTransition(current, 'processing', { reason: 'Processing started' }),
        ),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await repository.findById(payment.id))?.statusHistory).toHaveLength(2);
  });
});

describe('FilePaymentRepository durability', () => {
  it('reloads payments, statuses and idempotency keys after a restart', async () => {
    const file = path.join(directory, 'nested', 'payments.json');
    const first = await FilePaymentRepository.open(file);
    const payment = buildPayment({ idempotencyKey: 'key-1' });
    await first.insert(payment);
    await first.update(payment.id, (current) =>
      applyTransition(current, 'processing', { reason: 'Processing started' }),
    );
    await first.flush();

    const reopened = await FilePaymentRepository.open(file);

    expect((await reopened.findById(payment.id))?.status).toBe('processing');
    expect((await reopened.findByIdempotencyKey('key-1'))?.id).toBe(payment.id);
    await expect(reopened.insert(buildPayment({ id: 'other', idempotencyKey: 'key-1' }))).rejects.toThrow(
      DuplicateIdempotencyKeyError,
    );
  });

  it('keeps the file valid JSON under a burst of concurrent writes', async () => {
    const file = path.join(directory, 'payments.json');
    const repository = await FilePaymentRepository.open(file);

    await Promise.all(
      Array.from({ length: 25 }, (_, index) => repository.insert(buildPayment({ id: `payment-${index}` }))),
    );

    const onDisk = JSON.parse(await readFile(file, 'utf8')) as unknown[];
    expect(onDisk).toHaveLength(25);
  });

  describe('when the disk write fails', () => {
    // A directory squatting on the temp file path makes every save fail,
    // the same way a full disk or a permissions problem would.
    const breakDisk = (file: string) => mkdir(`${file}.tmp`);
    const repairDisk = (file: string) => rmdir(`${file}.tmp`);

    it('rejects the insert and does not keep the payment in memory either', async () => {
      const file = path.join(directory, 'payments.json');
      const repository = await FilePaymentRepository.open(file);
      const payment = buildPayment({ idempotencyKey: 'key-1' });
      await breakDisk(file);

      await expect(repository.insert(payment)).rejects.toThrow();

      expect(await repository.findById(payment.id)).toBeNull();
      expect(await repository.findByIdempotencyKey('key-1')).toBeNull();
    });

    it('rejects the update and keeps the previous status', async () => {
      const file = path.join(directory, 'payments.json');
      const repository = await FilePaymentRepository.open(file);
      const payment = buildPayment();
      await repository.insert(payment);
      await breakDisk(file);

      await expect(
        repository.update(payment.id, (current) =>
          applyTransition(current, 'processing', { reason: 'Processing started' }),
        ),
      ).rejects.toThrow();

      expect((await repository.findById(payment.id))?.status).toBe('pending');
    });

    it('works again once the disk recovers, and the retry succeeds cleanly', async () => {
      const file = path.join(directory, 'payments.json');
      const repository = await FilePaymentRepository.open(file);
      const payment = buildPayment({ idempotencyKey: 'key-1' });
      await breakDisk(file);
      await expect(repository.insert(payment)).rejects.toThrow();
      await repairDisk(file);

      await repository.insert(payment);

      const reopened = await FilePaymentRepository.open(file);
      expect(await reopened.findById(payment.id)).toEqual(payment);
    });
  });

  it('refuses to start from a corrupt file instead of discarding data', async () => {
    const file = path.join(directory, 'payments.json');
    await writeFile(file, '{ not json', 'utf8');

    await expect(FilePaymentRepository.open(file)).rejects.toThrow(/is corrupt/);
  });

  it('refuses a file that is valid JSON but not a list of payments', async () => {
    const file = path.join(directory, 'payments.json');
    await writeFile(file, '{"payments": []}', 'utf8');

    await expect(FilePaymentRepository.open(file)).rejects.toThrow(/expected a JSON array/);
  });
});
