/* Flow layout for a money trail: columns are hops (longest path from a source), so money always moves
   left → right in time order. Pure and dependency-free so it can be checked on its own (flow.check.mjs). */
export type FlowNode = { id: string; role: string };
export type FlowEdge = { id: string; source: string; target: string; kind: string; amount?: number; ts?: string };
export type Column = { depth: number; kind: "sources" | "hop" | "exits"; ts: string | null; x: number; y: number };
export type Flow = { pos: Record<string, { x: number; y: number }>; columns: Column[]; delta: Record<string, number> };

export function flowLayout(nodes: FlowNode[], edges: FlowEdge[], vertical = false, gapX = 210, gapY?: number): Flow {
  const money = edges.filter((e) => e.kind === "money").sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  const accounts = nodes.filter((n) => n.role !== "device").map((n) => n.id);
  const depth: Record<string, number> = Object.fromEntries(accounts.map((id) => [id, 0]));

  // Longest-path depth; capped at the node count so a cycle can't loop forever.
  for (let pass = 0, changed = true; changed && pass < accounts.length; pass++) {
    changed = false;
    for (const e of money) {
      const d = Math.min(depth[e.source] + 1, accounts.length);
      if (d > depth[e.target]) { depth[e.target] = d; changed = true; }
    }
  }

  const cols: string[][] = [];
  for (const id of accounts) (cols[depth[id]] ??= []).push(id);
  // Tall columns (fan-out rings) pack tighter so the whole ring stays legible without zooming far out.
  const gy = gapY ?? Math.max(42, Math.min(76, 480 / Math.max(1, ...cols.map((c) => c?.length ?? 0))));
  const firstOut = (id: string) => money.find((e) => e.source === id)?.ts ?? "";
  const firstIn = (id: string) => money.find((e) => e.target === id)?.ts ?? "";
  const row: Record<string, number> = {};
  cols.forEach((col, d) => {
    if (!col) return;
    if (d === 0) col.sort((a, b) => firstOut(a).localeCompare(firstOut(b)) || a.localeCompare(b));
    else {  // barycentre of where the money came from, to keep lines from crossing
      const bary = (id: string) => {
        const ys = money.filter((e) => e.target === id && e.source in row).map((e) => row[e.source]);
        return ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : 0;
      };
      col.sort((a, b) => bary(a) - bary(b) || firstIn(a).localeCompare(firstIn(b)));
    }
    col.forEach((id, i) => { row[id] = i - (col.length - 1) / 2; });
  });

  const pos: Flow["pos"] = {};
  for (const id of accounts) pos[id] = { x: depth[id] * gapX, y: row[id] * gy };
  const maxY = Math.max(0, ...accounts.map((id) => pos[id].y));
  const minY = Math.min(0, ...accounts.map((id) => pos[id].y));

  // Shared devices sit in a lane below, under the accounts that use them.
  const devices = nodes.filter((n) => n.role === "device").map((n) => n.id);
  devices.forEach((dev, i) => {
    const users = edges.filter((e) => e.kind === "shared_device" && e.target === dev && e.source in pos).map((e) => pos[e.source].x);
    const x = users.length ? users.reduce((s, v) => s + v, 0) / users.length : 0;
    pos[dev] = { x: x + i * 36, y: maxY + Math.max(gy * 1.4, 64) };
  });

  const outs = new Set(money.map((e) => e.source));
  const columns: Column[] = cols.flatMap((col, d) => (!col ? [] : [{
    depth: d,
    kind: d === 0 ? "sources" as const : col.every((id) => !outs.has(id)) ? "exits" as const : "hop" as const,
    ts: (d === 0 ? col.map(firstOut) : col.map(firstIn)).filter(Boolean).sort()[0] ?? null,
    x: d * gapX, y: minY - Math.max(gy, 58),
  }]));

  // Minutes each transfer waited after money last reached its sender: the pass-through speed.
  const delta: Flow["delta"] = {};
  for (const e of money) {
    const arrived = money.filter((m) => m.target === e.source && (m.ts ?? "") <= (e.ts ?? "")).map((m) => m.ts!).sort().pop();
    if (arrived && e.ts) delta[e.id] = Math.round((Date.parse(e.ts) - Date.parse(arrived)) / 60000);
  }

  if (vertical) {
    for (const k in pos) pos[k] = { x: pos[k].y, y: pos[k].x };
    for (const c of columns) [c.x, c.y] = [c.y, c.x];
  }
  return { pos, columns, delta };
}

export const minutes = (m: number) => (m < 60 ? `+${m}m` : `+${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`);
