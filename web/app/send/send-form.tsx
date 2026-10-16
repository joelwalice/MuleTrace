"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { API, PATTERN, inr, post, when, type Snapshot } from "../lib";

/* Judge-facing page: send transfers into the live bank from a phone, then watch for the rules to catch them. */
const ID = /^[A-Z0-9][A-Z0-9-]{2,23}$/;
const CHANNELS = ["upi", "imps", "neft", "rtgs", "cash", "card", "atm"] as const;
type Transfer = { sender: string; receiver: string; amount: number; channel: (typeof CHANNELS)[number] };
type Sent = Transfer & { id: number; at: string };

function myTag() {
  try {
    const saved = localStorage.getItem("mt-tag");
    if (saved) return saved;
    const tag = `JUDGE-${Math.floor(Math.random() * 90 + 10)}`;
    localStorage.setItem("mt-tag", tag);
    return tag;
  } catch { return "JUDGE-01"; }
}

export default function SendForm() {
  const [tag, setTag] = useState("JUDGE-01");
  const [form, setForm] = useState({ sender: "", receiver: "", amount: "", channel: "upi" as Transfer["channel"] });
  const [errors, setErrors] = useState<Partial<Record<"sender" | "receiver" | "amount" | "form", string>>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent[]>([]);
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    const t = myTag();
    setTag(t);
    setForm((f) => ({ ...f, sender: f.sender || t, receiver: f.receiver || `${t}-POT` }));
    const es = new EventSource(`${API}/stream`);
    es.onmessage = (e) => setSnap(JSON.parse(e.data));
    return () => es.close();
  }, []);

  // Alerts that touch any account this person has used: the "you got caught" moment.
  const mine = useMemo(() => new Set(sent.flatMap((t) => [t.sender, t.receiver])), [sent]);
  const caught = (snap?.alerts ?? []).filter((a) => mine.has(a.account_id));

  const send = async (batch: Transfer[]) => {
    setBusy(true);
    setErrors({});
    try {
      await post(`/ingest`, batch);
      const at = snap?.clock ?? new Date().toISOString();
      setSent((s) => [...batch.map((t, i) => ({ ...t, id: Date.now() + i, at })).reverse(), ...s].slice(0, 30));
    } catch {
      setErrors({ form: `The bank didn’t accept that. Check the API is running at ${API}, then try again.` });
    }
    setBusy(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const sender = form.sender.trim().toUpperCase(), receiver = form.receiver.trim().toUpperCase();
    const amount = Number(form.amount.replace(/[,₹\s]/g, ""));
    const next: typeof errors = {};
    if (!ID.test(sender)) next.sender = "Use 3–24 letters, digits or dashes, like JUDGE-07.";
    if (!ID.test(receiver)) next.receiver = "Use 3–24 letters, digits or dashes, like AC0042.";
    else if (receiver === sender) next.receiver = "Send to a different account than the one it comes from.";
    if (!(amount > 0 && amount <= 10_000_000)) next.amount = "Enter an amount between ₹1 and ₹1,00,00,000.";
    setErrors(next);
    if (Object.keys(next).length) {
      document.getElementById(Object.keys(next)[0])?.focus();
      return;
    }
    send([{ sender, receiver, amount, channel: form.channel }]);
  };

  // One-tap scenarios that should trip the rules, so a judge can test the engine themselves.
  const scenarios: { label: string; hint: string; run: () => Transfer[] }[] = [
    { label: "Structuring", hint: "3 cash deposits of ₹49,500 into one account, just under the ₹50,000 PAN limit",
      run: () => [1, 2, 3].map((i) => ({ sender: `${tag}-S${i}`, receiver: `${tag}-POT`, amount: 49500, channel: "cash" as const })) },
    { label: "Pass-Through", hint: "Receive ₹2,40,000, then send ₹2,30,000 straight on",
      run: () => [{ sender: `${tag}-BOSS`, receiver: tag, amount: 240000, channel: "imps" as const },
                  { sender: tag, receiver: `${tag}-EXIT`, amount: 230000, channel: "imps" as const }] },
  ];

  const field = "w-full border border-line-hi bg-bg px-3 py-2.5 font-mono text-[15px] uppercase text-ink placeholder:normal-case placeholder:text-muted focus:border-ink focus:outline-none";
  const label = "tl mb-1.5 block text-ink-2";
  const err = (k: keyof typeof errors) => errors[k] && <p id={`${k}-err`} className="msg mt-1.5 font-sans text-[13px] text-red" role="alert">{errors[k]}</p>;

  return (
    <main className="mx-auto grid min-h-dvh max-w-lg content-start gap-px bg-line pb-[env(safe-area-inset-bottom,0px)]">
      <header className="bg-bg px-4 pb-4 pt-[max(16px,env(safe-area-inset-top,0px))]">
        <a href="/" className="tl text-muted hover:text-ink">← MuleTrace Console</a>
        <h1 className="macro mt-3 text-[40px] text-ink">Send a Transfer</h1>
        <p className="mt-2 font-sans text-[15px] text-ink-2">
          Your money goes into the live bank on the big screen. Try to move it like a mule and see if the rules catch you.
        </p>
        <p className="tl mt-3 text-ink-2" aria-live="polite">
          {!snap ? "Connecting to the bank…" : snap.running
            ? <><span className="text-green">● Live</span> · Bank clock {when(snap.clock)}</>
            : <span className="text-red">○ Feed paused on the console. Transfers queue until it resumes.</span>}
        </p>
      </header>

      <form onSubmit={submit} noValidate className="grid gap-4 bg-panel px-4 py-5" aria-describedby={errors.form ? "form-err" : undefined}>
        <div>
          <label htmlFor="sender" className={label}>From Account</label>
          <input id="sender" name="sender" autoComplete="off" spellCheck={false} autoCapitalize="characters" className={field}
            placeholder={`${tag}…`} value={form.sender} aria-invalid={!!errors.sender} aria-describedby={errors.sender ? "sender-err" : undefined}
            onChange={(e) => setForm({ ...form, sender: e.target.value })} />
          {err("sender")}
        </div>
        <div>
          <label htmlFor="receiver" className={label}>To Account</label>
          <input id="receiver" name="receiver" autoComplete="off" spellCheck={false} autoCapitalize="characters" className={field}
            placeholder="AC0042…" value={form.receiver} aria-invalid={!!errors.receiver} aria-describedby={errors.receiver ? "receiver-err" : undefined}
            onChange={(e) => setForm({ ...form, receiver: e.target.value })} />
          {err("receiver")}
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
          <div>
            <label htmlFor="amount" className={label}>Amount (₹)</label>
            <input id="amount" name="amount" inputMode="decimal" autoComplete="off" className={field}
              placeholder="49,500…" value={form.amount} aria-invalid={!!errors.amount} aria-describedby={errors.amount ? "amount-err" : undefined}
              onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            {err("amount")}
          </div>
          <div>
            <label htmlFor="channel" className={label}>Channel</label>
            <select id="channel" name="channel" className={`${field} bg-bg text-ink`} value={form.channel}
              onChange={(e) => setForm({ ...form, channel: e.target.value as Transfer["channel"] })}>
              {CHANNELS.map((c) => <option key={c} value={c} className="bg-bg text-ink">{c.toUpperCase()}</option>)}
            </select>
          </div>
        </div>
        {errors.form && <p id="form-err" className="msg font-sans text-[13px] text-red" role="alert">{errors.form}</p>}
        <button type="submit" disabled={busy}
          className="tl bg-ink py-3 text-[13px] font-semibold text-bg transition-colors hover:bg-red active:translate-y-px disabled:opacity-60">
          {busy ? "Sending…" : "Send Transfer"}
        </button>
      </form>

      <section className="bg-bg px-4 py-5" aria-labelledby="try-h">
        <h2 id="try-h" className="tl text-red"><span aria-hidden>[ </span>Try to Fool It<span aria-hidden> ]</span></h2>
        <div className="mt-3 grid gap-px bg-line">
          {scenarios.map((sc) => (
            <button key={sc.label} disabled={busy} onClick={() => send(sc.run())}
              className="grid gap-1 border-l-2 border-transparent bg-panel px-3 py-3 text-left transition-colors hover:border-red hover:bg-raised active:bg-raised disabled:opacity-60">
              <span className="tl text-ink">Send {sc.label} Pattern</span>
              <span className="msg font-sans text-[13px] text-ink-2">{sc.hint}</span>
            </button>
          ))}
        </div>
      </section>

      {(caught.length > 0 || sent.length > 0) && (
        <section className="bg-bg px-4 py-5" aria-labelledby="mine-h" aria-live="polite">
          <h2 id="mine-h" className="tl text-ink"><span aria-hidden>[ </span>Your Activity<span aria-hidden> ]</span></h2>
          {caught.map((a) => (
            <a key={a.alert_id} href={`/?alert=${a.alert_id}`} className="mt-3 block border border-red px-3 py-2.5 transition-colors hover:bg-red hover:text-bg">
              <span className="tl text-red"><span aria-hidden>▲ </span>Caught · {a.alert_id}</span>
              <span className="msg mt-1 block font-sans text-[14px]">
                <span translate="no" className="font-mono">{a.account_id}</span> flagged for {a.pattern.split("+").map((p) => PATTERN[p]).join(", ")}. {a.reasons[0]}.
              </span>
              <span className="tl mt-1 block text-[11.5px] text-ink-2">Open in Console →</span>
            </a>
          ))}
          <ul className="mt-3 font-mono text-[13px] uppercase">
            {sent.map((t) => (
              <li key={t.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-line py-1.5">
                <span className="truncate"><span translate="no">{t.sender}</span> <span aria-hidden className="text-muted">→</span><span className="sr-only">to</span> <span translate="no">{t.receiver}</span> <span className="text-muted">{t.channel}</span></span>
                <span className="num text-ink">{inr(t.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
