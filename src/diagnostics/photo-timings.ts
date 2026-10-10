import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { PhotoPhase, PhotoSpan } from './contracts';

type Scope = { recorder: PhotoTimingRecorder; evidenceId?: string; parentId?: string };
const scope = new AsyncLocalStorage<Scope>();
export interface PhotoTimingOptions {
  enabled: boolean;
  write(rows: PhotoSpan[], signal: AbortSignal): Promise<void>;
  monotonic?: () => number;
  now?: () => Date;
  evidenceId?: (id: string) => string;
}
/** Bounded, best-effort collector. Neither phase success nor failure awaits diagnostic I/O. */
export class PhotoTimingRecorder {
  private pending = new Map<string, PhotoSpan>();
  private active: Promise<void> | undefined;
  private controller = new AbortController();
  private closed = false;
  private count = 0;
  private lastRow: PhotoSpan | undefined;
  omitted = 0;
  constructor(private readonly options: PhotoTimingOptions) {}
  get enabled() { return this.options.enabled && !this.closed; }
  identity(id: string) { return this.options.evidenceId?.(id) ?? id; }
  clock() { return this.options.monotonic?.() ?? performance.now(); }
  now() { return (this.options.now?.() ?? new Date()).toISOString(); }
  start(evidenceId: string, parentId: string | undefined, phase: PhotoPhase): PhotoSpan | undefined {
    if (!this.enabled || this.count >= 500) {
      if (this.enabled) { this.omitted = Math.min(5000, this.omitted + 1); if (this.lastRow) this.enqueue({ ...this.lastRow, omittedCount: this.omitted }); }
      return;
    }
    this.count++;
    const row: PhotoSpan = { id: randomUUID(), evidenceId, parentId: parentId ?? null, phase, state: 'running', startedAt: this.now(), completedAt: null, durationMs: null, errorCode: null };
    this.enqueue(row);
    return row;
  }
  finish(row: PhotoSpan, start: number, failed: boolean) {
    const elapsed = this.clock() - start;
    this.enqueue({ ...row, state: failed ? 'failed' : 'complete', completedAt: new Date(Math.max(Date.parse(row.startedAt), Date.parse(this.now()))).toISOString(), durationMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : null, errorCode: failed ? 'phase_failed' : null });
  }
  private enqueue(row: PhotoSpan) {
    if (this.closed) return;
    this.lastRow = row;
    this.pending.set(row.id, { ...row, omittedCount: this.omitted });
    if (!this.active) {
      // Start I/O on another microtask; never run the sink inside the measured operation.
      this.active = Promise.resolve().then(async () => {
        while (this.pending.size && !this.closed) {
          const batch = [...this.pending.values()].slice(0, 32);
          for (const item of batch) this.pending.delete(item.id);
          try { await this.options.write(batch.map(row => ({ ...row, omittedCount: this.omitted })), this.controller.signal); }
          catch {
            this.omitted = Math.min(5000, this.omitted + batch.length);
            // One bounded recovery write makes lost measurements explicit if the sink recovers.
            try { await this.options.write(batch.map(row => ({ ...row, state: "incomplete", durationMs: null, errorCode: "collection_incomplete", omittedCount: this.omitted })), this.controller.signal); }
            catch { /* A total outage cannot persist its own failure. */ }
          }
        }
      }).catch(() => undefined).finally(() => {
        this.active = undefined;
        const next = this.pending.values().next().value;
        if (next && !this.closed) this.enqueue(next);
      });
    }
  }
  async flush(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const drained = async () => { while (this.active) await this.active; };
      await Promise.race([drained(), new Promise<void>(resolve => { timeout = setTimeout(resolve, 100); })]);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.closed = true;
      this.omitted += this.pending.size;
      this.pending.clear();
      this.controller.abort();
    }
  }
}
export async function runPhotoTimingJob<T>(recorder: PhotoTimingRecorder, operation: () => Promise<T>): Promise<T> {
  return scope.run({ recorder }, async () => { try { return await operation(); } finally { await recorder.flush(); } });
}
export function withPhotoTiming<T>(evidenceId: string, operation: () => Promise<T>): Promise<T> {
  const current = scope.getStore();
  return current ? scope.run({ recorder: current.recorder, evidenceId: current.recorder.identity(evidenceId) }, operation) : operation();
}
export async function measurePhotoPhase<T>(phase: PhotoPhase, operation: () => Promise<T>): Promise<T> {
  const current = scope.getStore();
  if (!current?.evidenceId || !current.recorder.enabled) return operation();
  const { recorder } = current;
  const start = recorder.clock();
  const row = recorder.start(current.evidenceId, current.parentId, phase);
  if (!row) return operation();
  let failed = false;
  try { return await scope.run({ ...current, parentId: row.id }, operation); }
  catch (error) { failed = true; throw error; }
  finally { recorder.finish(row, start, failed); }
}
