export interface AsyncLearningQueueOptions {
  batchSize?: number;
}

type Work = { key: string; operation: () => Promise<unknown> };

export class AsyncLearningQueue {
  private readonly pending: Work[] = [];
  private readonly keys = new Set<string>();
  private readonly batchSize: number;
  private draining: Promise<void> | undefined;

  constructor(options: AsyncLearningQueueOptions = {}) {
    this.batchSize = Math.max(1, options.batchSize ?? 16);
  }

  enqueue(key: string, operation: () => Promise<unknown>): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.pending.push({ key, operation });
    void this.drain();
    return true;
  }

  async flush(): Promise<void> {
    await this.drain();
  }

  get size(): number {
    return this.pending.length + (this.draining ? 1 : 0);
  }

  private async drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.pending.length) {
        const batch = this.pending.splice(0, this.batchSize);
        await Promise.all(batch.map(async (work) => {
          try {
            await work.operation();
          } finally {
            this.keys.delete(work.key);
          }
        }));
      }
    })().finally(() => { this.draining = undefined; });
    return this.draining;
  }
}
