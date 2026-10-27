// Small, dependency-free statistics for comparing agent variants. Tasks are the unit of analysis: repeated trials of one task are
// correlated, so every interval here resamples tasks, never individual runs.

/** Deterministic PRNG (mulberry32) so a report can be reproduced exactly. */
export function rng(seed = 1): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export type Interval = { lo: number; hi: number };
/** Percentile bootstrap CI of `stat` over tasks (each element is one task's data). */
export function bootstrap<T>(items: T[], stat: (xs: T[]) => number, o: { B?: number; seed?: number; level?: number } = {}): Interval {
  if (items.length < 2) { const v = items.length ? stat(items) : NaN; return { lo: v, hi: v }; }
  const B = o.B ?? 4000, r = rng(o.seed ?? 7), est: number[] = [];
  for (let b = 0; b < B; b++) { const s: T[] = []; for (let i = 0; i < items.length; i++) s.push(items[Math.floor(r() * items.length)]); const v = stat(s); if (!Number.isNaN(v)) est.push(v); }
  est.sort((x, y) => x - y);
  const a = (1 - (o.level ?? 0.95)) / 2;
  return { lo: quantile(est, a), hi: quantile(est, 1 - a) };
}

/** Exact two-sided sign test: of the tasks where two variants differ, `wins` favour A and `losses` favour B (McNemar's exact test on discordant pairs). */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses; if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let p = 0, c = 1; // c = C(n, i) built iteratively
  for (let i = 0; i <= k; i++) { p += c; c = (c * (n - i)) / (i + 1); }
  return Math.min(1, (2 * p) / 2 ** n);
}

const choose = (n: number, k: number) => { if (k < 0 || k > n) return 0; let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
/** Unbiased estimate of "all k of k independent attempts pass" from c passes in n trials (reliability, as in pass^k). */
export const passPowK = (c: number, n: number, k: number) => (k > n ? NaN : choose(c, k) / choose(n, k));
/** Unbiased estimate of "at least one of k attempts passes" (pass@k). */
export const passAtK = (c: number, n: number, k: number) => (k > n ? NaN : 1 - choose(n - c, k) / choose(n, k));

/** Holm-Bonferroni adjusted p-values (controls the family-wise error when comparing several variants at once). */
export function holm(ps: number[]): number[] {
  const idx = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]), out = new Array<number>(ps.length);
  let run = 0;
  idx.forEach(([p, i], rank) => { run = Math.max(run, Math.min(1, p * (ps.length - rank))); out[i] = run; });
  return out;
}

/** Smallest paired difference in pass rate that `n` tasks can reliably detect (rough, 80% power, alpha 0.05, worst-case variance). */
export const minDetectable = (nTasks: number) => (nTasks > 0 ? Math.min(1, (2.8 * Math.sqrt(0.5)) / Math.sqrt(nTasks)) : 1);
