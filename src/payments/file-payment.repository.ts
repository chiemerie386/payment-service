import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InMemoryPaymentRepository, type PaymentRepository } from './payment.repository';
import type { Payment, PaymentStatus } from './payment.types';

/**
 * JSON file persistence. Reads are served from memory; a write only becomes
 * visible after it is safely on disk.
 *
 * How a write works:
 *  1. Writes run one at a time through a queue, so they can never interleave.
 *  2. The change is applied to a private copy of the data.
 *  3. The copy is written to a temp file, which is then renamed over the real
 *     file. A crash mid-write leaves the previous good file intact.
 *  4. Only then does the copy replace the live data.
 *
 * If step 3 fails (disk full, permissions), the caller gets the error and the
 * live data is untouched: memory and disk never disagree, and the API never
 * acknowledges a payment that was not saved.
 *
 * It rewrites the whole file on each change, which is fine for a simulation
 * and exactly why a real service would use a database instead.
 */
export class FilePaymentRepository implements PaymentRepository {
  private writeQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private committed: InMemoryPaymentRepository,
  ) {}

  static async open(filePath: string): Promise<FilePaymentRepository> {
    const resolved = path.resolve(filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    return new FilePaymentRepository(resolved, new InMemoryPaymentRepository(await load(resolved)));
  }

  insert(payment: Payment): Promise<Payment> {
    return this.write((draft) => draft.insert(payment));
  }

  findById(id: string): Promise<Payment | null> {
    return this.committed.findById(id);
  }

  findByIdempotencyKey(key: string): Promise<Payment | null> {
    return this.committed.findByIdempotencyKey(key);
  }

  findByStatus(statuses: readonly PaymentStatus[]): Promise<Payment[]> {
    return this.committed.findByStatus(statuses);
  }

  update(id: string, mutate: (current: Payment) => Payment): Promise<Payment | null> {
    return this.write((draft) => draft.update(id, mutate));
  }

  /** Resolves once every write requested so far has finished. */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private write<T>(change: (draft: InMemoryPaymentRepository) => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(async () => {
      const draft = new InMemoryPaymentRepository(this.committed.snapshot());
      const outcome = await change(draft); // throws (and commits nothing) if a rule is violated
      if (outcome !== null) {
        await this.saveToDisk(draft.snapshot());
        this.committed = draft;
      }
      return outcome;
    });
    // Keep the queue usable after a failed write; the caller still sees the rejection.
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  private async saveToDisk(payments: Payment[]): Promise<void> {
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(payments, null, 2), 'utf8');
    await rename(tempPath, this.filePath);
  }
}

async function load(filePath: string): Promise<Payment[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('expected a JSON array of payments');
    }
    return parsed as Payment[];
  } catch (error) {
    // Refuse to start rather than silently discarding payment records.
    throw new Error(`Payment data file ${filePath} is corrupt: ${(error as Error).message}`, {
      cause: error,
    });
  }
}
