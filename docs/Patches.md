Edits to existing files

New files go next to their neighbours: relations.py, inference_api.py, test_relations.py beside app.py; inference.tsx in web/app/. I did not have web/app/lib.ts, ui.tsx, globals.css or package.json, so the web edits are written against the files you pasted and are not type-checked or built.

app.py
python
# imports
import relations as rel
from inference_api import build_router

# Live.reset(): next to `self.labels = {}`
self.suspected = rel.SuspectedStore()   # inferred relationships; never part of self.txns

# right after `LIVE = Live()`
INFERENCE, add_suspected = build_router(LIVE)

# after `app = FastAPI(...)` and the CORS middleware
app.include_router(INFERENCE)

# alert_graph(): last line
return add_suspected(graph(edges, mt.device_links({a["account_id"]} | lateral, LIVE.out, LIVE.devs), role))
# network_graph(): last line
return add_suspected(graph(n["edges"], n["devices"], role))

# COPILOT_TOOLS: read-only tools only. reviewSuspectedEdge is deliberately absent: an analyst decides.
"explainRingGaps", "traceReturnPaths", "scoreCloseness", "listSuspectedEdges", "getSuspectedEdge"
web/app/lib.ts

Widen the graph edge type: kind: "money" | "shared_device" | "suspected", plus optional directed?: boolean; score?: number; status?: string; label?: string.

web/app/graph.tsx
In sheet(), add "--amber" to the destructured token list as amber (fall back: const am = amber || ink2), then add after the shared_device edge rule:
ts
{ selector: "edge[kind='suspected']", style: { "line-style": "dashed", "line-dash-pattern": [6, 4], width: 2, "line-color": am, "target-arrow-color": am,
    "target-arrow-shape": "triangle", opacity: 0.9, label: "data(dlabel)" } },
In the els mapping for edges: dlabel: e.kind === "suspected" ? "inferred" : flow.delta[e.id] != null ? minutes(flow.delta[e.id]) : "".
Tooltip, next to the money-edge handler:
ts
c.on("mouseover", "edge[kind='suspected']", (e: EventObject) => {
  const ed = e.target, p = ed.renderedMidpoint(), d = ed.data();
  setTip({ x: p.x, y: p.y, value: Number(d.score).toFixed(2), unit: "inferred closeness",
           lines: [`${d.source} ⇢ ${d.target}`, "Not a recorded transfer", `Status: ${d.status}`, "Evidence: Inferred tab"] });
});
Required: hover path tracing must ignore inferred edges, or "follow the money" would run through a guess. In the node mouseover handler replace the path line with:
ts
const susp = c.edges("[kind='suspected']"); susp.remove();
const path = n.predecessors().union(n.successors()).union(n);
susp.restore();
web/app/page.tsx
tsx
import { InferenceView, useInference } from "./inference";
type Side = "feed" | "evidence" | "inferred" | "profile" | "signals";
const SIDE_LABEL = { ..., inferred: "Inferred" };
// readQuery: panel === "inferred" is accepted like the other panels
// after selSig/detail are defined:
const inference = useInference(sel?.kind === "network" ? sel.id : detail?.network_id, selSig);
// tab list: ["feed","evidence","inferred","profile","signals"], and grid-cols-4 -> grid-cols-5
// panel body, before the profile branch:
: side === "inferred" ? <InferenceView inf={inference} setCite={setCite} />
// graph: cite={side === "evidence" || side === "inferred" ? cite : undefined}
// GraphToolbar legend, two more <li>:
<li className="flex items-center gap-1.5"><span aria-hidden className="inline-block w-5 border-t-2 border-solid border-ink" />Recorded Transfer</li>
<li className="flex items-center gap-1.5"><span aria-hidden className="inline-block w-5 border-t-2 border-dashed border-ink" />Inferred, Not a Transfer</li>
// GraphFrame caption: append "Dashed lines are inferences, not recorded transfers."

TrailTable already filters kind === "money", so inferred edges never appear in the transfer table.

web/flow.check.mjs (append before the final console.log)
js
// Inferred edges must never change the layout of recorded money.
const withGuess = flowLayout(nodes, [...edges, { id: "SE-x", source: "A", target: "X", kind: "suspected" }]);
assert.deepEqual(withGuess.pos, f.pos, "suspected edges do not move nodes");
assert.deepEqual(withGuess.delta, f.delta, "suspected edges add no wait times");
README.md

Add a short "Gaps and inferences" section linking INFERENCE.md, and add the new endpoints to the Microsoft wiring list (Copilot Studio re-import of /copilot/openapi.json).