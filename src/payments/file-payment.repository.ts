import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InMemoryPaymentRepository, type PaymentRepository } from './payment.repository';
import type { Payment, PaymentStatus } from './payment.types';

/**
 * JSON file persistence. Reads are served from memory; every write is flushed
 * to disk before the call resolves, so an acknowledged payment survives a
 * restart.
 *
 * Two details matter here:
 *  - writes are chained, so two saves can never interleave and corrupt the file;
 *  - each save writes a temp file and renames it over the real one, so a crash
 *    mid-write leaves the previous good file intact.
 *
 * It rewrites the whole file on each change, which is fine for a simulation
 * and exactly why a real service would use a database instead.
 */
export class FilePaymentRepository implements PaymentRepository {
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private readonly store: InMemoryPaymentRepository,
  ) {}

  static async open(filePath: string): Promise<FilePaymentRepository> {
    const resolved = path.resolve(filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    return new FilePaymentRepository(resolved, new InMemoryPaymentRepository(await load(resolved)));
  }

  async insert(payment: Payment): Promise<Payment> {
    const inserted = await this.store.insert(payment);
    await this.persist();
    return inserted;
  }

  findById(id: string): Promise<Payment | null> {
    return this.store.findById(id);
  }

  findByIdempotencyKey(key: string): Promise<Payment | null> {
    return this.store.findByIdempotencyKey(key);
  }

  findByStatus(statuses: readonly PaymentStatus[]): Promise<Payment[]> {
    return this.store.findByStatus(statuses);
  }

  async update(id: string, mutate: (current: Payment) => Payment): Promise<Payment | null> {
    const updated = await this.store.update(id, mutate);
    if (updated) {
      await this.persist();
    }
    return updated;
  }

  /** Resolves once every write requested so far is on disk. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private persist(): Promise<void> {
    const write = this.writeChain.then(async () => {
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, JSON.stringify(this.store.snapshot(), null, 2), 'utf8');
      await rename(tempPath, this.filePath);
    });
    // Keep the chain alive after a failed write; the caller still sees the rejection.
    this.writeChain = write.catch(() => undefined);
    return write;
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
