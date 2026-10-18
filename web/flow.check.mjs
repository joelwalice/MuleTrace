// Run: node flow.check.mjs   (Node strips the TypeScript types itself)
import assert from "node:assert/strict";
import { flowLayout, minutes } from "./app/flow.ts";

const n = (id, role = "member") => ({ id, role });
const m = (id, source, target, ts) => ({ id, source, target, kind: "money", amount: 100, ts });
// Chain with a fan: F → A → (B, C) → X, plus a shared device on B and C.
const nodes = [n("F", "source"), n("A"), n("B"), n("C"), n("X"), n("D1", "device")];
const edges = [
  m("e1", "F", "A", "2026-10-14T09:00:00"), m("e2", "A", "B", "2026-10-14T09:09:00"),
  m("e3", "A", "C", "2026-10-14T09:10:00"), m("e4", "B", "X", "2026-10-14T09:30:00"), m("e5", "C", "X", "2026-10-14T10:40:00"),
  { id: "d1", source: "B", target: "D1", kind: "shared_device" }, { id: "d2", source: "C", target: "D1", kind: "shared_device" },
];
const f = flowLayout(nodes, edges);
assert.deepEqual([f.pos.F.x, f.pos.A.x, f.pos.B.x, f.pos.X.x], [0, 210, 420, 630], "columns follow hops");
assert.equal(f.pos.B.x, f.pos.C.x, "siblings share a column");
assert.ok(f.pos.D1.y > Math.max(f.pos.B.y, f.pos.C.y), "devices sit below");
assert.deepEqual(f.columns.map((c) => c.kind), ["sources", "hop", "hop", "exits"]);
assert.equal(f.columns[2].ts, "2026-10-14T09:09:00", "column time = first arrival");
assert.deepEqual([f.delta.e1, f.delta.e2, f.delta.e4, f.delta.e5], [undefined, 9, 21, 90], "wait after arrival");
assert.equal(minutes(90), "+1h 30m");
const v = flowLayout(nodes, edges, true);
assert.equal(v.pos.X.y, 630, "vertical mode swaps axes");
// A cycle must terminate.
flowLayout([n("P"), n("Q")], [m("c1", "P", "Q", "2026-10-14T09:00:00"), m("c2", "Q", "P", "2026-10-14T09:05:00")]);
// Inferred edges must never change the layout of recorded money.
const withGuess = flowLayout(nodes, [...edges, { id: "SE-x", source: "A", target: "X", kind: "suspected" }]);
assert.deepEqual(withGuess.pos, f.pos, "suspected edges do not move nodes");
assert.deepEqual(withGuess.delta, f.delta, "suspected edges add no wait times");
console.log("flow layout check ok");
