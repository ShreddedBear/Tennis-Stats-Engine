export async function withTimeBudget<T>(
  label: string,
  timeoutMs: number,
  work: Promise<T>,
  onTimeout?: (label: string, timeoutMs: number) => void,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>(resolve => {
        timer = setTimeout(() => {
          onTimeout?.(label, timeoutMs);
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class BoundedOperationPool {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  private async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>(resolve => this.waiting.push(resolve));
    this.active++;
  }

  private release() {
    this.active--;
    this.waiting.shift()?.();
  }

  async runWithBudget<T>(label: string, timeoutMs: number, work: () => Promise<T>, fallback: () => T): Promise<T> {
    await this.acquire();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let returned = false;
    const operation = Promise.resolve().then(work);
    operation.finally(() => this.release()).catch(() => undefined);
    try {
      return await Promise.race([
        operation,
        new Promise<T>(resolve => {
          timer = setTimeout(() => {
            returned = true;
            console.warn(`[research-timing] ${label} exceeded ${timeoutMs}ms; bounded fallback used`);
            resolve(fallback());
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer && !returned) clearTimeout(timer);
    }
  }

  get activeCount() {
    return this.active;
  }
}