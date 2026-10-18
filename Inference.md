Gaps and inferences in MuleTrace

Design rule: show what is observed, identify what is suspected, reveal what is missing. Never present an inferred relationship as a verified transfer. The verified ledger (LIVE.txns) is never written by this code. Inferences live in LIVE.suspected (a SuspectedStore) and are returned with inferred: true, verified: false.

1. First-hop blind spot (relations.first_hop_findings)

For a ring or alert trail, each earliest observed account (sends but never receives within the trail; for a pure cycle, the earliest sender) gets a finding. true_origin is always "unknown". No sender is invented.

finding_type	meaning	status
possible_missing_first_hop	no incoming transfer to this account exists anywhere in the dataset	supported_by_observed_data if the dataset covers the lookback (default 72 h) before its first transfer and at least 2 downstream transfers are recorded; otherwise insufficient_evidence
observed_incoming_outside_trail	incoming transfers exist but the trail's filters (min amount, window) excluded them	under_review: widen the trail
earliest_observed_in_cycle	the only incoming transfers are the trail's own return legs	under_review

supported_by_observed_data means only that the records show outflow with no recorded funding in a window long enough to expect it. It is not evidence about who the source was. Confidence is a qualitative label (insufficient/low/medium, never high, since absence of records cannot be proven). Downstream behaviour (downstream_signals: hops, rapid hops) is reported separately from the missing-first-hop finding. prior_activity lets the caller say an account is known to predate the dataset; that forces insufficient_evidence.

2. Possible return paths (relations.return_paths)

Depth-first search over recorded transfers: each hop strictly after the previous in (timestamp, txn_id) order (ties broken by id, so the result is deterministic and never goes backward), over distinct accounts, ending at the origin.

No delay cap by default. max_span is optional and echoed. Other limits (all echoed in limits; hitting one is listed in truncated): max_depth 6, max_paths 25, max_branch 25, max_expansions 20 000, min_amount, window_start/end.
Partial and split returns: several paths ending in different incoming transfers are reported, and aggregate counts each incoming payment once (returned_total, returned_to_sent, partial_returns). Amounts may differ: amount_relation is similar/reduced/exceeds (a label, never a filter).
Incoming payments with no recorded chain from the origin are listed as unlinked_incoming, explicitly not returns.
Every path is label: possible_return_path, confirmed: false, attribution: not_established.
evidence_strength counts independent signals other than the return itself: rapid_hop, repeated_counterparty, amount_similar, alerted_intermediary (existing rules), multiple_partial_returns. Timing irregularity is reported but contributes nothing. Weak = return only.
3. Recency-weighted closeness (relations.closeness_score)

Per observation: score_i = weight_i × reliability_i × exp(−λ · age_days_i), λ = ln 2 / half_life_days (default 14 days; MULETRACE_HALF_LIFE_DAYS or ?half_life_days=). Observations after the reference time (bank clock) are excluded.

evidence	direction	reliability	weight
direct_transfer (recorded)	directed	0.90	0.5 per transfer (repetition corroborates)
cash_link (atm out → later cash in, ≤5 % apart, ≤24 h)	directed hypothesis	0.35	(1−½·amount_gap/tol)(1−½·time_gap/max_gap) ÷ look-alike matches
shared_device	undirected	0.60	1/√(accounts on the device − 1)
common_counterparty	undirected	0.25	1/log₂(2 + counterparty's degree), top 5

Combination: observations are de-duplicated so a transaction supports at most one counted observation (the strongest wins; the rest are listed as discounted), then combined by noisy-OR 1 − Π(1 − score_i), then capped by evidence quality:

no recorded interaction and one kind of evidence: ≤ 0.30 (weak)
no recorded interaction, several kinds: ≤ 0.60 (moderate)
strong (≥ 0.65) is reachable only with recorded transfers.

Recency multiplies by ≤ 1, so it fades a score and can never lift it past a cap. Output keeps components (a_to_b, b_to_a, undirected) apart; score is the direction-agnostic total on [0, 1]. Strength bands: <0.10 insufficient, <0.35 weak, <0.65 moderate, else strong. The score is a heuristic priority: not a probability of guilt, not proof of common ownership, not proof that money moved. The numbers (reliabilities, caps, thresholds) are unvalidated defaults and are configurable (ClosenessConfig). Device evidence is unavailable (and listed as such) when no device identifier is recorded for an account. IBM-style data has none.

4. Suspected relationships (build_suspected, SuspectedStore)

Rule cash_withdrawal_deposit_match v1 pairs an atm transfer from A with a later cash transfer into B (≤24 h, ≤5 % apart), skipping pairs where A itself sent the deposit (that is a recorded transfer). Schema caveat: transfers always have a sender and receiver, so "withdrawal" and "deposit" are read from the channel; configure cash_out_channels / cash_in_channels for real data. An edge is created only if the closeness reaches create_threshold (0.15) after recency decay and ambiguity; otherwise the pair is returned in insufficient as separate events. Each edge has: stable id (SE- + hash of type and endpoints), source/target, relationship_type, created_at, supporting_txn_ids, method, heuristic score (labelled as such), strength, explanation, statement (an explicit inference notice), alternative_explanations, missing_evidence, limitations, status, and an audit history. Statuses: suspected → under_review / corroborated / rejected. Corroborating or rejecting requires a note. A rejection survives re-scans; if new evidence arrives, new_evidence_since_rejection is set instead of silently reopening. corroborated records an analyst finding; it still does not make the edge a transaction. Nothing freezes accounts from a closeness score.

API
endpoint	purpose
GET /network/{id}/inference	first-hop findings, return paths, inferred edges touching the ring (explainRingGaps)
GET /account/{id}/return-paths?max_depth&max_paths&max_span_hours&min_amount	return search for any account (traceReturnPaths)
GET /closeness?a&b&half_life_days	closeness with every observation (scoreCloseness)
GET /suspected, GET /suspected/{id}	inferred edges (listSuspectedEdges, getSuspectedEdge)
POST /suspected/{id}/review	{decision, analyst, note}; analyst-only, not a Copilot tool
GET /network/{id}/graph, /alert/{id}/graph	now also carry kind: "suspected" edges between nodes already drawn

The app has no authentication today; these endpoints inherit the deployment's protection. Existing contracts are unchanged (additive only).

Try it
bash
# a return path, irregular timing: three calls a few seconds apart (bank time moves 30x)
curl -XPOST localhost:8000/ingest -H 'content-type: application/json' -d '[{"sender":"JUDGE-01","receiver":"JUDGE-02","amount":80000}]'
curl -XPOST localhost:8000/ingest -H 'content-type: application/json' -d '[{"sender":"JUDGE-02","receiver":"JUDGE-03","amount":79000}]'
curl -XPOST localhost:8000/ingest -H 'content-type: application/json' -d '[{"sender":"JUDGE-03","receiver":"JUDGE-01","amount":50000}]'
curl localhost:8000/account/JUDGE-01/return-paths
# an inferred cash link
curl -XPOST localhost:8000/ingest -H 'content-type: application/json' -d '[{"sender":"JUDGE-10","receiver":"JUDGE-ATM","amount":49000,"channel":"atm"}]'
curl -XPOST localhost:8000/ingest -H 'content-type: application/json' -d '[{"sender":"JUDGE-WALK","receiver":"JUDGE-20","amount":49000,"channel":"cash"}]'
curl localhost:8000/suspected

Launching the fan and structuring attacks close together can produce a few weak, coincidental cash-link edges between unrelated rings. That is the ambiguity discount and the 0.30 cap doing their job; review and reject them.

Limitations
Bounded search: no result is exhaustive, and "none found" is never "none exist".
No per-account behavioural baseline, so "deviation from history" is not a signal yet.
Fees, spending and netting are not modelled; amount similarity is a label only.
Cash-link detection depends on channel labels; the synthetic bank only produces them in attacks.
Reliabilities, caps and thresholds are not calibrated against labelled data. The IBM AML data has no cash-withdrawal/deposit pairs, no device data and no informal transfers, so it cannot validate any of this and eval_ibm.py was not extended.
The classifier in xai.py is untouched; none of these findings feed it.
Suspected edges and their audit trail are in memory (single worker), like cases, and reset with New Bank.