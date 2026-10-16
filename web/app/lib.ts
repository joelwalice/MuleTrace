export const API = process.env.NEXT_PUBLIC_API ?? "http://localhost:8000";

export type Sev = "high" | "medium" | "low";
export type Txn = {
  txn_id: string; ts: string; sender_account: string; receiver_account: string;
  amount: number; channel: string; device_id: string; suspicious?: boolean;
};
export type Alert = {
  alert_id: string; account_id: string; network_id: string; score: number; severity: Sev;
  pattern: string; reasons: string[]; amount: number; status: string; ts: string;
};
export type Network = {
  network_id: string; alert_ids: string[]; accounts: string[]; alerted: string[]; sources: string[];
  freeze: string[]; exits: string[]; score: number; severity: Sev; patterns: string[];
  total_in: number; first_ts: string; last_ts: string; status: string;
};
export type Snapshot = {
  version: number; clock: string; running: boolean; speed: number; speeds: number[]; feed_rate: number;
  queued: number; autopilot: boolean; attacks: Attack[];
  stats: { transactions: number; alerts: number; networks: number; total_in: number; frozen: number; cases: number };
  hourly: number[]; alerts: Alert[]; networks: Network[]; feed: Txn[];
};
export type Attack = { id: string; kind: "structuring" | "chain" | "fan"; label: string; started: string; total: number; left: number };
export const ATTACKS: { kind: Attack["kind"]; label: string; key: string; hint: string }[] = [
  { kind: "structuring", label: "Structuring", key: "1", hint: "6 depositors, cash just under ₹50,000" },
  { kind: "chain", label: "Pass-Through Chain", key: "2", hint: "Dormant account wakes up, 3 fast hops" },
  { kind: "fan", label: "Fan-In / Fan-Out", key: "3", hint: "8 in → hub → 8 mules → ATM" },
];
export type GNode = { id: string; name: string; risk: number; role: string; frozen: boolean };
export type GEdge = { id: string; source: string; target: string; amount?: number; ts?: string; kind: "money" | "shared_device" };
export type Graph = { nodes: GNode[]; edges: GEdge[] };
export type Detail = {
  severity: Sev; status: string; score: number; explanation: string; str_draft: string;
  network_id: string; alert_id?: string; account_id?: string;
  // network-only
  freeze?: string[]; sources?: string[]; mules?: string[]; exits?: string[]; accounts?: string[]; alerted?: string[]; total_in?: number;
  // alert-only
  upstream?: string[]; downstream?: string[]; lateral?: string[]; reasons?: string[];
};
export type Profile = {
  account_id: string; name: string; type: string; open_date: string; home_branch: string; kyc_risk: number;
  risk: number; frozen: boolean; total_received: number; unique_senders: number; total_sent: number;
  unique_receivers: number; passthrough_pct: number; avg_minutes_to_forward: number | null;
  devices: string[]; ips: string[]; alerts: Alert[]; txns: Txn[];
};
export type Sel = { kind: "network" | "alert"; id: string } | null;
export type Case = { case_id: string; frozen: string[]; review: string[]; webhook: string };

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(API + path, body === undefined ? { method: "POST" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

// All number and date output goes through Intl, in Indian conventions (lakh grouping, ₹, L/Cr compact).
const INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const INR_COMPACT = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", notation: "compact", maximumFractionDigits: 2 });
const NUM = new Intl.NumberFormat("en-IN");
const DATETIME = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const TIME = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DATE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
export const inr = (n: number) => INR.format(n);
export const compactInr = (n: number) => INR_COMPACT.format(n);
export const num = (n: number) => NUM.format(Math.round(n));
export const when = (ts: string) => DATETIME.format(new Date(ts));
export const clock = (ts: string) => TIME.format(new Date(ts));
export const day = (ts: string) => DATE.format(new Date(ts));
export const reducedMotion = () => typeof window !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const PATTERN: Record<string, string> = {
  structuring: "Structuring", passthrough: "Rapid pass-through", fan_in_out: "Fan-in / fan-out",
  dormant: "Dormant wake-up", shared_device: "Shared device",
};

// Risk bands match the backend's severity cut-offs; colours come from the validated --risk-0..3 ramp.
export const RISK_BANDS = ["< 0.40", "0.40–0.69", "0.70–0.84", "≥ 0.85"];
export const riskBand = (r: number) => (r >= 0.85 ? 3 : r >= 0.7 ? 2 : r >= 0.4 ? 1 : 0);
export const SEV_LABEL: Record<Sev, string> = { high: "High", medium: "Medium", low: "Low" };
export const playbookNote = (webhook: string) =>
  webhook.startsWith("sent") ? "Teams and Planner notified through Power Automate."
  : webhook.startsWith("not configured") ? "Power Automate isn’t connected yet. Set PLAYBOOK_WEBHOOK on the API to send Teams alerts."
  : `Power Automate call failed: ${webhook.replace(/^failed: /, "")}`;
