// Dependency-free line diff -> unified hunks. Trims common head/tail first, then LCS on the middle (capped).
export type FileChange = { path: string; created: boolean; added: number; removed: number; diff: string };
type Op = { t: " " | "+" | "-"; s: string; a: number; b: number }; // a/b: 1-based line numbers in old/new (0 = absent)

const lines = (s: string) => { if (!s) return []; const l = s.split("\n"); if (l.at(-1) === "") l.pop(); return l; };

function ops(A: string[], B: string[]): Op[] {
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let sA = A.length, sB = B.length;
  while (sA > p && sB > p && A[sA - 1] === B[sB - 1]) { sA--; sB--; }
  const out: Op[] = [];
  for (let i = 0; i < p; i++) out.push({ t: " ", s: A[i], a: i + 1, b: i + 1 });
  const a = A.slice(p, sA), b = B.slice(p, sB), n = a.length, m = b.length;
  const del = (i: number) => out.push({ t: "-", s: a[i], a: p + i + 1, b: 0 });
  const add = (j: number) => out.push({ t: "+", s: b[j], a: 0, b: p + j + 1 });
  if (n * m > 4_000_000) { a.forEach((_, i) => del(i)); b.forEach((_, j) => add(j)); } // huge rewrite: don't pay O(n*m)
  else {
    const w = m + 1, L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ t: " ", s: a[i], a: p + i + 1, b: p + j + 1 }); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) del(i++); else add(j++);
    }
    while (i < n) del(i++);
    while (j < m) add(j++);
  }
  for (let k = sA; k < A.length; k++) out.push({ t: " ", s: A[k], a: k + 1, b: sB + (k - sA) + 1 });
  return out;
}

export function unifiedDiff(path: string, before: string | null, after: string, ctx = 3, maxLines = 400): FileChange {
  const created = before === null, all = ops(lines(before ?? ""), lines(after));
  const added = all.filter((o) => o.t === "+").length, removed = all.filter((o) => o.t === "-").length;
  if (!added && !removed) return { path, created, added, removed, diff: "" };
  const keep: [number, number][] = [];
  all.forEach((o, i) => {
    if (o.t === " ") return;
    const lo = Math.max(0, i - ctx), hi = Math.min(all.length - 1, i + ctx), last = keep.at(-1);
    if (last && lo <= last[1] + 1) last[1] = hi; else keep.push([lo, hi]);
  });
  const out = [`--- ${created ? "/dev/null" : "a/" + path}`, `+++ b/${path}`];
  for (const [lo, hi] of keep) {
    const h = all.slice(lo, hi + 1);
    const aStart = h.find((o) => o.a)?.a ?? all.slice(0, lo).findLast((o) => o.a)?.a ?? 0, bStart = h.find((o) => o.b)?.b ?? all.slice(0, lo).findLast((o) => o.b)?.b ?? 0;
    out.push(`@@ -${aStart},${h.filter((o) => o.t !== "+").length} +${bStart},${h.filter((o) => o.t !== "-").length} @@`);
    for (const o of h) out.push(o.t + o.s);
  }
  const diff = out.length > maxLines ? [...out.slice(0, maxLines), `… ${out.length - maxLines} more diff lines`].join("\n") : out.join("\n");
  return { path, created, added, removed, diff };
}
