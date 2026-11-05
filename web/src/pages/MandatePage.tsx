import { useEffect, useState, type ReactNode } from "react";
import { CATEGORY_VOCAB, type Mandate, type Purchase, type Recipient, type RecipientStatus } from "../../../shared/types";
import { api, isFixture } from "../api";
import { DecideButtons } from "../components/cards";
import { Icon } from "../components/Icon";
import { StatusPill } from "../components/MandateMeter";
import { dateInputToIso, dateOnly, isoToDateInput, money } from "../format";
import { envelopeTotal, giftPurchase, giftTitle, MAX_HOLD_DAYS, maxExpiryIso, newRecipientId, stateLabel } from "../giftlist";
import { navigate } from "../router";
import { useStore } from "../store";

const EXAMPLE =
  "Holiday gifts, $200 total. Mom $60, she loves gardening. Dad $50, coffee nerd. My nephews Leo $30 (dinosaurs) and Sam $30 (soccer). Office Secret Santa $30, something for the desk. Ask me before anything over $45. No electronics.";

const MAX_PEOPLE = 12;

const modeLabel: Record<Mandate["paypal"]["mode"], string> = {
  authorization: "PayPal authorization hold",
  vault: "PayPal saved payment (vault)",
  per_purchase: "Approve each payment in PayPal",
  mock: "Mock payments (dev only)",
};

/** With people on the list, the total is the sum of their envelopes (spec decision 1). */
function withDerivedTotal(m: Mandate): Mandate {
  return m.recipients.length > 0 ? { ...m, budget_total: envelopeTotal(m.recipients) } : m;
}

export function MandatePage() {
  const { state } = useStore();
  const m = state?.mandate ?? null;
  const [startOver, setStartOver] = useState(false);

  if (!state) return <PageSkeleton />;

  if (m && !startOver && m.status === "active") {
    return <ActiveMandate m={m} remaining={state.remaining} people={state.recipients} purchases={state.purchases} />;
  }
  if (m && !startOver && (m.status === "revoked" || m.status === "expired" || m.status === "exhausted")) {
    return (
      <ActiveMandate
        m={m}
        remaining={state.remaining}
        people={state.recipients}
        purchases={state.purchases}
        onNew={() => setStartOver(true)}
      />
    );
  }
  // draft or pending_paypal: resume the review form with the saved gift list
  const resume = m && !startOver && (m.status === "draft" || m.status === "pending_paypal") ? m : null;
  return <CreateMandate initial={resume} />;
}

function PageSkeleton() {
  return (
    <div className="page">
      <div className="skeleton" style={{ height: 48, width: "40%" }} />
      <div className="skeleton" style={{ height: 220, marginTop: 16 }} />
    </div>
  );
}

// ---------- create / review ----------

function CreateMandate({ initial }: { initial: Mandate | null }) {
  const { run } = useStore();
  const [text, setText] = useState(EXAMPLE);
  const [draft, setDraft] = useState<Mandate | null>(initial ? withDerivedTotal(initial) : null);
  const [saved, setSaved] = useState<boolean>(!!initial?.id);
  const [busy, setBusy] = useState<"parse" | "save" | "approve" | null>(null);

  // Adopt the server copy when a different gift list (or status) arrives, not on every state refresh,
  // so edits in progress are not overwritten.
  const initialKey = initial ? `${initial.id}:${initial.status}` : "";
  useEffect(() => {
    if (initial) {
      setDraft(withDerivedTotal(initial));
      setSaved(!!initial.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  const parse = async () => {
    setBusy("parse");
    const out = await run(() => api.parseMandate(text));
    if (out) {
      setDraft(withDerivedTotal(out.mandate));
      setSaved(false);
    }
    setBusy(null);
  };

  const edit = (patch: Partial<Mandate>) => {
    setDraft((d) => (d ? withDerivedTotal({ ...d, ...patch }) : d));
    setSaved(false);
  };

  const problems = draft ? validate(draft) : [];

  const save = async (): Promise<Mandate | undefined> => {
    if (!draft) return undefined;
    const out = await run(() => api.saveMandate(draft), "Gift list saved");
    if (out) {
      setDraft(withDerivedTotal(out.mandate));
      setSaved(true);
    }
    return out?.mandate;
  };

  const onSave = async () => {
    setBusy("save");
    await save();
    setBusy(null);
  };

  const onApprove = async () => {
    setBusy("approve");
    const m = saved && draft?.id ? draft : await save();
    if (!m) {
      setBusy(null);
      return;
    }
    const out = await run(() => api.approveMandate(m.id));
    if (out?.approveUrl) {
      if (isFixture && out.approveUrl.startsWith("fixture:")) {
        setBusy(null);
        navigate(out.approveUrl.slice("fixture:".length));
        return;
      }
      window.location.assign(out.approveUrl);
      return; // keep the busy state while the browser leaves
    }
    setBusy(null);
  };

  const maxDate = isoToDateInput(maxExpiryIso());

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <p className="eyebrow">Step 1 · Gift list</p>
        <h1>Every gift on your list, tied to one PayPal approval</h1>
        <p className="lede">
          Type your list once: who, how much each, what they like. You approve one PayPal hold for the total. The agent
          then buys a gift for everyone, each inside that person's envelope, and asks you before anything over your limit.
        </p>
      </header>

      <section className="panel giftbox">
        <label className="field-label" htmlFor="rule">
          Your gift list, in plain language
        </label>
        <textarea id="rule" className="rule-input" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row-end">
          <button className="btn btn-secondary" onClick={parse} disabled={busy !== null || !text.trim()}>
            {busy === "parse" ? <span className="spinner" /> : <Icon name="sparkle" size={16} />}
            {busy === "parse" ? "Drafting…" : "Draft with AI"}
          </button>
        </div>
      </section>

      {draft && (
        <section className="panel review fade-in" aria-label="Review gift list">
          <div className="review-head">
            <div>
              <h2>Review before you approve</h2>
              <p className="muted small">The AI drafted this. Every field is yours to change.</p>
            </div>
            {draft.status !== "draft" && <StatusPill status={draft.status} />}
          </div>

          <div className="form-grid">
            <Field label="Title" wide>
              <input value={draft.title} onChange={(e) => edit({ title: e.target.value })} />
            </Field>
          </div>

          <RecipientEditor recipients={draft.recipients} onChange={(recipients) => edit({ recipients })} />

          <div className="form-grid">
            <Field label="Ask me above" hint="Per gift; above this the agent must ask you">
              <MoneyInput value={draft.per_purchase_approval_over} onChange={(v) => edit({ per_purchase_approval_over: v })} />
            </Field>
            <Field label="Max quantity per item">
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={draft.max_quantity_per_item}
                onChange={(e) => edit({ max_quantity_per_item: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
              />
            </Field>
            <Field label="Expires" hint={`PayPal holds the budget for up to ${MAX_HOLD_DAYS} days`} wide>
              <input
                type="date"
                max={maxDate}
                value={isoToDateInput(draft.expires_at)}
                onChange={(e) => {
                  if (!e.target.value) return;
                  // Later dates are capped at the PayPal hold (the server applies the same cap).
                  edit({ expires_at: dateInputToIso(e.target.value > maxDate ? maxDate : e.target.value) });
                }}
              />
            </Field>
          </div>

          <CategoryPicker
            allowed={draft.allowed_categories}
            blocked={draft.blocked_categories}
            onChange={(allowed, blocked) => edit({ allowed_categories: allowed, blocked_categories: blocked })}
          />

          {problems.length > 0 && (
            <ul className="form-problems" role="alert">
              {problems.map((p) => (
                <li key={p}>
                  <Icon name="alert" size={15} /> {p}
                </li>
              ))}
            </ul>
          )}

          <div className="review-actions">
            <button className="btn btn-ghost" onClick={onSave} disabled={busy !== null || problems.length > 0 || saved}>
              {busy === "save" ? <span className="spinner" /> : null}
              {saved ? "Saved" : "Save"}
            </button>
            <button className="btn btn-paypal" onClick={onApprove} disabled={busy !== null || problems.length > 0}>
              {busy === "approve" ? <span className="spinner" /> : <Icon name="shieldCheck" size={18} />}
              Approve {money(draft.budget_total)} with PayPal
            </button>
          </div>
          <p className="fine-print">
            You will sign in to PayPal and approve one hold of up to {money(draft.budget_total)} for the whole list. The
            agent can then charge only inside each person's envelope and these rules, and you can revoke it at any time.
          </p>
        </section>
      )}
    </div>
  );
}

function validate(m: Mandate): string[] {
  const out: string[] = [];
  if (!m.title.trim()) out.push("Give the gift list a title.");
  if (m.recipients.length === 0) out.push("Add at least one person to the list.");
  if (m.recipients.length > MAX_PEOPLE) out.push(`A list can have up to ${MAX_PEOPLE} people.`);
  const seen = new Set<string>();
  m.recipients.forEach((r, i) => {
    const name = r.name.trim();
    if (!name) out.push(`Give person ${i + 1} a name.`);
    if (!(r.envelope > 0)) out.push(`Give ${name || `person ${i + 1}`} an envelope above $0.`);
    const key = name.toLowerCase();
    if (key && seen.has(key)) out.push(`"${name}" is on the list twice. Each name must be unique.`);
    if (key) seen.add(key);
  });
  if (!Number.isFinite(m.per_purchase_approval_over) || m.per_purchase_approval_over < 0) out.push("Set an ask-me amount of $0 or more.");
  if (m.budget_total > 0 && m.per_purchase_approval_over > m.budget_total) out.push("The ask-me amount is above the whole total.");
  if (m.allowed_categories.length === 0) out.push("Allow at least one category.");
  if (Date.parse(m.expires_at) < Date.now()) out.push("The expiry date is in the past.");
  return [...new Set(out)];
}

function RecipientEditor({ recipients, onChange }: { recipients: Recipient[]; onChange: (r: Recipient[]) => void }) {
  const set = (i: number, patch: Partial<Recipient>) => onChange(recipients.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(recipients.filter((_, j) => j !== i));
  const add = () => onChange([...recipients, { id: newRecipientId(), name: "", envelope: NaN, interests: "" }]);
  const total = envelopeTotal(recipients);

  return (
    <fieldset className="rcp">
      <legend className="field-label">
        Who is on the list <span className="field-hint">one envelope each; the agent cannot spend past it</span>
      </legend>
      {recipients.length > 0 && (
        <div className="rcp-cols" aria-hidden>
          <span>Name</span>
          <span>Envelope</span>
          <span>Interests</span>
          <span />
        </div>
      )}
      <ul className="rcp-rows">
        {recipients.map((r, i) => {
          const who = r.name.trim() || `person ${i + 1}`;
          return (
            <li className="rcp-row" key={r.id}>
              <label className="rcp-name">
                <span className="rcp-label">Name</span>
                <input value={r.name} placeholder="Name" maxLength={60} aria-label={`Name of person ${i + 1}`} onChange={(e) => set(i, { name: e.target.value })} />
              </label>
              <label className="rcp-env">
                <span className="rcp-label">Envelope</span>
                <MoneyInput value={r.envelope} label={`Envelope for ${who}`} onChange={(v) => set(i, { envelope: v })} />
              </label>
              <label className="rcp-int">
                <span className="rcp-label">Interests</span>
                <input
                  value={r.interests}
                  placeholder="What they like"
                  maxLength={120}
                  aria-label={`Interests of ${who}`}
                  onChange={(e) => set(i, { interests: e.target.value })}
                />
              </label>
              <button type="button" className="btn btn-ghost btn-icon rcp-remove" onClick={() => remove(i)} aria-label={`Remove ${who}`} title={`Remove ${who}`}>
                <Icon name="x" size={16} />
              </button>
            </li>
          );
        })}
      </ul>
      {recipients.length === 0 && <p className="rcp-empty muted small">No one on the list yet. Add the people you are buying for.</p>}
      <div className="rcp-foot">
        <button type="button" className="btn btn-ghost btn-sm" onClick={add} disabled={recipients.length >= MAX_PEOPLE}>
          <Icon name="plus" size={15} /> Add a person
        </button>
        <div className="rcp-total" aria-live="polite">
          <span>
            Total <span className="field-hint">sum of the envelopes</span>
          </span>
          <strong>{money(total)}</strong>
        </div>
      </div>
    </fieldset>
  );
}

function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`field ${wide ? "field-wide" : ""}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function MoneyInput({ value, onChange, label }: { value: number; onChange: (v: number) => void; label?: string }) {
  return (
    <span className="money-input">
      <span aria-hidden>$</span>
      <input
        type="number"
        min={0}
        step="0.01"
        inputMode="decimal"
        aria-label={label}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
      />
    </span>
  );
}

function CategoryPicker({
  allowed,
  blocked,
  onChange,
}: {
  allowed: string[];
  blocked: string[];
  onChange: (allowed: string[], blocked: string[]) => void;
}) {
  const toggle = (list: "allowed" | "blocked", c: string) => {
    if (list === "allowed") {
      const on = allowed.includes(c);
      onChange(on ? allowed.filter((x) => x !== c) : [...allowed, c], blocked.filter((x) => x !== c));
    } else {
      const on = blocked.includes(c);
      onChange(allowed.filter((x) => x !== c), on ? blocked.filter((x) => x !== c) : [...blocked, c]);
    }
  };
  return (
    <div className="cat-picker">
      <fieldset>
        <legend className="field-label">
          Allowed categories <span className="field-hint">anything else is refused</span>
        </legend>
        <div className="chips">
          {CATEGORY_VOCAB.map((c) => (
            <button
              type="button"
              key={c}
              className={`chip chip-toggle ${allowed.includes(c) ? "on-allow" : ""}`}
              aria-pressed={allowed.includes(c)}
              onClick={() => toggle("allowed", c)}
            >
              {allowed.includes(c) && <Icon name="check" size={13} />}
              {c}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="field-label">
          Always blocked <span className="field-hint">refused even if asked</span>
        </legend>
        <div className="chips">
          {CATEGORY_VOCAB.map((c) => (
            <button
              type="button"
              key={c}
              className={`chip chip-toggle ${blocked.includes(c) ? "on-block" : ""}`}
              aria-pressed={blocked.includes(c)}
              onClick={() => toggle("blocked", c)}
            >
              {blocked.includes(c) && <Icon name="x" size={13} />}
              {c}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

// ---------- active / ended ----------

const stateBadge: Record<RecipientStatus["state"], string> = {
  bought: "badge-charged",
  waiting_approval: "badge-pending_approval",
  to_buy: "badge-to_buy",
};

/** Per-person envelopes: a mini meter each (spent of envelope, plus any gift waiting for approval). */
function Envelopes({ people, purchases, live }: { people: RecipientStatus[]; purchases: Purchase[]; live: boolean }) {
  const bought = people.filter((p) => p.state === "bought").length;
  const waiting = people.filter((p) => p.state === "waiting_approval").length;
  return (
    <div className="env">
      <div className="env-head">
        <h2 className="panel-title">Envelopes</h2>
        <span className="muted small">
          {bought} of {people.length} bought{waiting ? ` · ${waiting} waiting for your OK` : ""}
        </span>
      </div>
      <ul className="env-rows">
        {people.map((st) => {
          const r = st.recipient;
          const gift = giftPurchase(st, purchases);
          const shown = gift && (gift.status === "charged" || gift.status === "pending_approval") ? gift : null;
          const pending = purchases
            .filter((p) => st.purchase_ids.includes(p.id) && p.status === "pending_approval")
            .reduce((s, p) => s + p.total, 0);
          const pct = (n: number) => (r.envelope > 0 ? Math.max(0, Math.min(1, n / r.envelope)) * 100 : 0);
          const spentPct = pct(st.spent);
          const pendingPct = Math.min(100 - spentPct, pct(pending));
          return (
            <li key={r.id} className={`env-row env-${st.state}`}>
              <div className="env-who">
                <span className="gs-avatar" aria-hidden>
                  {r.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="env-name">
                  <strong>{r.name}</strong>
                  {r.interests && <span className="muted small">{r.interests}</span>}
                </span>
              </div>
              <span className={`badge badge-plain env-badge ${stateBadge[st.state]}`}>{stateLabel[st.state]}</span>
              <div className="env-gift">
                {shown ? (
                  <>
                    <Icon name="gift" size={15} />
                    <span className="env-gift-title">{giftTitle(shown)}</span>
                    <span className="env-gift-price">{money(shown.total)}</span>
                  </>
                ) : (
                  <span className="muted small">No gift yet</span>
                )}
                {live && shown?.status === "pending_approval" && (
                  <div className="env-decide">
                    <DecideButtons p={shown} />
                  </div>
                )}
              </div>
              <div className="env-meter">
                <div className="env-nums">
                  <span>
                    <strong>{money(st.spent)}</strong> <span className="muted">of {money(r.envelope)}</span>
                  </span>
                  <span className="muted">{pending > 0 ? `${money(pending)} waiting` : `${money(st.remaining)} left`}</span>
                </div>
                <div
                  className="env-track"
                  role="meter"
                  aria-label={`${r.name}: ${money(st.spent)} spent of ${money(r.envelope)}`}
                  aria-valuemin={0}
                  aria-valuemax={r.envelope}
                  aria-valuenow={st.spent}
                >
                  <span className="env-fill" style={{ width: `${spentPct}%` }} />
                  {pendingPct > 0 && <span className="env-pending" style={{ width: `${pendingPct}%` }} />}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ActiveMandate({
  m,
  remaining,
  people,
  purchases,
  onNew,
}: {
  m: Mandate;
  remaining: number;
  people: RecipientStatus[];
  purchases: Purchase[];
  onNew?: () => void;
}) {
  const { run } = useStore();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = m.status === "active";
  const spentNet = m.spent - m.refunded;
  const pct = m.budget_total > 0 ? Math.min(1, Math.max(0, spentNet / m.budget_total)) : 0;

  const revoke = async () => {
    setBusy(true);
    await run(() => api.revokeMandate(m.id), "Gift list revoked. The agent can no longer spend.");
    setBusy(false);
    setConfirm(false);
  };

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <p className="eyebrow">Gift list</p>
        <div className="title-row">
          <h1>{m.title}</h1>
          <StatusPill status={m.status} />
        </div>
      </header>

      <section className={`panel giftbox mandate-card ${live ? "" : "is-ended"}`}>
        <div className="budget-hero">
          <div>
            <span className="muted small">Left to spend</span>
            <div className="hero-num">{money(live || m.status === "exhausted" ? remaining : 0)}</div>
            <span className="muted small">
              of {money(m.budget_total)} · {money(spentNet)} spent net of refunds
              {people.length > 0 ? ` · ${people.length} ${people.length === 1 ? "person" : "people"}` : ""}
            </span>
          </div>
          <div className="hero-bar" aria-hidden>
            <div className="hero-bar-fill" style={{ width: `${pct * 100}%` }} />
          </div>
        </div>

        {people.length > 0 && <Envelopes people={people} purchases={purchases} live={live} />}

        <dl className="rules">
          <div>
            <dt>Ask me above</dt>
            <dd>{money(m.per_purchase_approval_over)} per gift</dd>
          </div>
          <div>
            <dt>Max per item</dt>
            <dd>{m.max_quantity_per_item} units</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>
              {dateOnly(m.expires_at)}
              <span className="dd-note">PayPal holds the budget for up to {MAX_HOLD_DAYS} days</span>
            </dd>
          </div>
          <div>
            <dt>Spending power</dt>
            <dd>{modeLabel[m.paypal.mode]}</dd>
          </div>
          <div className="rules-wide">
            <dt>Allowed</dt>
            <dd className="chips">
              {m.allowed_categories.map((c) => (
                <span key={c} className="chip on-allow">
                  {c}
                </span>
              ))}
            </dd>
          </div>
          {m.blocked_categories.length > 0 && (
            <div className="rules-wide">
              <dt>Blocked</dt>
              <dd className="chips">
                {m.blocked_categories.map((c) => (
                  <span key={c} className="chip on-block">
                    {c}
                  </span>
                ))}
              </dd>
            </div>
          )}
          {(m.paypal.authorization_id || m.paypal.vault_id) && (
            <div className="rules-wide">
              <dt>{m.paypal.authorization_id ? "PayPal authorization" : "PayPal vault token"}</dt>
              <dd>
                <code>{m.paypal.authorization_id ?? m.paypal.vault_id}</code>
              </dd>
            </div>
          )}
        </dl>

        {live && (
          <div className="cta-row">
            <button className="btn btn-primary" onClick={() => navigate("/agent")}>
              <Icon name="bot" size={18} /> Shop the list with the agent
            </button>
          </div>
        )}
      </section>

      {live ? (
        <section className="panel revoke-panel">
          <div className="revoke-text">
            <h2>
              <Icon name="power" size={18} /> Revoke gift list
            </h2>
            <p>
              Revoking cancels the agent's spending power at PayPal itself (the authorization is voided or the saved
              payment token is deleted). Any purchase the agent tries after that is refused. Gifts already bought stay in
              the ledger and can still be refunded.
            </p>
          </div>
          {confirm ? (
            <div className="revoke-actions">
              <button className="btn btn-ghost" onClick={() => setConfirm(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={revoke} disabled={busy}>
                {busy ? <span className="spinner" /> : <Icon name="power" size={16} />} Yes, revoke now
              </button>
            </div>
          ) : (
            <div className="revoke-actions">
              <button className="btn btn-danger-outline" onClick={() => setConfirm(true)}>
                <Icon name="power" size={16} /> Revoke gift list
              </button>
            </div>
          )}
        </section>
      ) : (
        <section className="panel notice-panel">
          <p>
            {m.status === "revoked"
              ? "This gift list was revoked. The agent has no spending power."
              : m.status === "expired"
                ? "This gift list expired. The agent has no spending power."
                : "The budget is used up. The agent can no longer buy anything on this gift list."}
          </p>
          {onNew && (
            <button className="btn btn-primary" onClick={onNew}>
              Create a new gift list
            </button>
          )}
        </section>
      )}
    </div>
  );
}
