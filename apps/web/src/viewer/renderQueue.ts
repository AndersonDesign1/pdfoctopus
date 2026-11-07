// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Schedules page renders on the single PDF worker. Only one render is sent at a time, so the
// most important job always goes next: pages on screen before thumbnails, and pages the user
// has scrolled past are dropped instead of rendered.

export class RenderCancelledError extends Error {
  constructor() {
    super("Render no longer needed");
    this.name = "RenderCancelledError";
  }
}

export interface RenderJob {
  /** Identifies the exact output (page, scale, kind); duplicate requests share one render. */
  key: string;
  index: number;
  scale: number;
  /** Lower runs first. Jobs with the same priority run in the order requested. */
  priority: number;
}

interface Entry<T> {
  job: RenderJob;
  order: number;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class RenderQueue<T> {
  private readonly queued = new Map<string, Entry<T>>();
  private readonly running = new Map<string, Entry<T>>();
  private counter = 0;

  constructor(
    private readonly run: (index: number, scale: number) => Promise<T>,
    private readonly maxInFlight = 1,
  ) {}

  /** Ask for a render. A request for a job already queued or running joins it. */
  request(job: RenderJob): Promise<T> {
    const existing = this.queued.get(job.key) ?? this.running.get(job.key);
    if (existing) {
      // Raise the priority if this caller needs it sooner.
      if (job.priority < existing.job.priority) existing.job = { ...existing.job, ...job };
      return existing.promise;
    }
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Callers that drop the promise mustn't trigger unhandled-rejection warnings on cancel.
    promise.catch(() => {});
    this.queued.set(job.key, { job, order: this.counter++, promise, resolve, reject });
    this.pump();
    return promise;
  }

  /** Drop queued (not yet running) jobs for which `keep` returns false. */
  retain(keep: (job: RenderJob) => boolean): void {
    for (const [key, entry] of this.queued) {
      if (!keep(entry.job)) {
        this.queued.delete(key);
        entry.reject(new RenderCancelledError());
      }
    }
  }

  /** Drop everything queued, e.g. when a different document is opened. */
  clear(): void {
    this.retain(() => false);
  }

  get size(): number {
    return this.queued.size + this.running.size;
  }

  private next(): Entry<T> | undefined {
    let best: Entry<T> | undefined;
    for (const entry of this.queued.values()) {
      if (
        !best ||
        entry.job.priority < best.job.priority ||
        (entry.job.priority === best.job.priority && entry.order < best.order)
      ) {
        best = entry;
      }
    }
    return best;
  }

  private pump(): void {
    while (this.running.size < this.maxInFlight) {
      const entry = this.next();
      if (!entry) return;
      this.queued.delete(entry.job.key);
      this.running.set(entry.job.key, entry);
      this.run(entry.job.index, entry.job.scale)
        .then(
          (value) => entry.resolve(value),
          (reason) => entry.reject(reason),
        )
        .finally(() => {
          this.running.delete(entry.job.key);
          this.pump();
        });
    }
  }
}
