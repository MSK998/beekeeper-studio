import rawLog from "@bksLogger";

const log = rawLog.scope("bks-perf");

interface Stat {
  count: number;
  totalMs: number;
  maxMs: number;
  bytes: number;
}

const stats = new Map<string, Stat>();

const AUTO_REPORT_INTERVAL_MS = 10000;

export function profilingEnabled(): boolean {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("BKS_PROFILE")) {
      return true;
    }
  } catch (_e) { /* localStorage unavailable */ }
  return typeof process !== "undefined" && !!process.env?.BKS_PROFILE
    && process.env.BKS_PROFILE !== "0";
}

function record(label: string, ms: number, bytes?: number) {
  const stat = stats.get(label) || { count: 0, totalMs: 0, maxMs: 0, bytes: 0 };
  stat.count += 1;
  stat.totalMs += ms;
  stat.maxMs = Math.max(stat.maxMs, ms);
  if (bytes) {
    stat.bytes += bytes;
  }
  stats.set(label, stat);
}

export function accumulate(label: string, ms: number, bytes?: number): void {
  if (!profilingEnabled()) return;
  record(label, ms, bytes);
}

export function timeSync<T>(label: string, fn: () => T): T {
  if (!profilingEnabled()) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    record(label, performance.now() - start);
  }
}

export async function timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!profilingEnabled()) return await fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    record(label, performance.now() - start);
  }
}

export function report(): void {
  if (stats.size === 0) {
    log.info("[perf] no timings recorded. Enable with BKS_PROFILE=1 env var or localStorage.setItem('BKS_PROFILE', '1')");
    return;
  }
  const lines = [...stats.entries()].map(([label, s]) => {
    const binary = s.bytes > 0 ? ` binary=${(s.bytes / 1024 / 1024).toFixed(1)}MB` : "";
    return `${label}: count=${s.count} total=${s.totalMs.toFixed(1)}ms `
      + `max=${s.maxMs.toFixed(1)}ms avg=${(s.totalMs / s.count).toFixed(2)}ms${binary}`;
  });
  log.info(`[perf] ---- profile report ----\n  ${lines.join("\n  ")}`);
}

export function reset(): void {
  stats.clear();
}

if (typeof window !== "undefined") {
  (window as any).__bksPerfReport = report;
  (window as any).__bksPerfReset = reset;
}

// Auto-report in every process that has profiling enabled (renderer, main,
// utility). Stats are per-process, so the utility process needs its own flush
// for pg.selectTop.query / db.serializeQueryResult to show up anywhere.
if (profilingEnabled() && typeof setInterval === "function") {
  const timer: ReturnType<typeof setInterval> = setInterval(report, AUTO_REPORT_INTERVAL_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

// Renderer only: catch main-thread stalls >50ms from ANY source (GC, layout,
// un-instrumented code) so lockups can be attributed by timestamp correlation.
if (profilingEnabled() && typeof PerformanceObserver !== "undefined" && typeof window !== "undefined") {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        record("longtask", entry.duration);
        if (entry.duration >= 100) {
          log.info(`[perf] long task: ${entry.duration.toFixed(1)}ms at t=${(entry.startTime / 1000).toFixed(2)}s`);
        }
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch (e) {
    log.debug("[perf] longtask observer unavailable", e);
  }
}
