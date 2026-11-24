/**
 * Minimum-cost assignment (Hungarian algorithm, O(n²m)) for track mapping
 * (ARCHITECTURE.md §8.3). Rectangular matrices are allowed: with n rows and m
 * columns, min(n, m) pairs are assigned.
 */

/** Returns, for each row, the assigned column or -1. */
export function assign(cost: number[][]): number[] {
  const rows = cost.length;
  if (rows === 0) return [];
  const cols = cost[0].length;
  if (cols === 0) return new Array(rows).fill(-1);
  // The classic formulation needs rows <= cols; transpose otherwise.
  if (rows > cols) {
    const t = Array.from({ length: cols }, (_, j) => cost.map((r) => r[j]));
    const colToRow = assign(t);
    const out = new Array(rows).fill(-1);
    colToRow.forEach((r, c) => {
      if (r >= 0) out[r] = c;
    });
    return out;
  }

  // 1-indexed potentials (e. maxx's formulation); p[j] = row assigned to column j.
  const u = new Array(rows + 1).fill(0);
  const v = new Array(cols + 1).fill(0);
  const p = new Array(cols + 1).fill(0);
  const way = new Array(cols + 1).fill(0);
  for (let i = 1; i <= rows; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(cols + 1).fill(Infinity);
    const used = new Array(cols + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= cols; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= cols; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const out = new Array(rows).fill(-1);
  for (let j = 1; j <= cols; j++) if (p[j] > 0) out[p[j] - 1] = j - 1;
  return out;
}
