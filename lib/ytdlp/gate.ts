/**
 * Concurrency gate used to cap how many yt-dlp processes may run at once.
 * Pure and injectable so tests can exercise it without spawning processes.
 */
export interface ExecutionGate {
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly activeCount: number;
  readonly queuedCount: number;
}

export function createExecutionGate(limit: number): ExecutionGate {
  const capacity = Math.max(1, Math.floor(limit));
  let active = 0;
  const queue: Array<() => void> = [];

  const release = (): void => {
    active -= 1;
    const next = queue.shift();
    if (next) {
      next();
    }
  };

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolveAcquire) => {
        const start = (): void => {
          active += 1;
          resolveAcquire(task().finally(release));
        };
        if (active < capacity) {
          start();
        } else {
          queue.push(start);
        }
      });
    },
    get activeCount(): number {
      return active;
    },
    get queuedCount(): number {
      return queue.length;
    },
  };
}
