import { useEffect, useState, type ReactNode } from "react";
import { CATEGORY_VOCAB, type Mandate } from "../../../shared/types";
import { api, isFixture } from "../api";
import { Icon } from "../components/Icon";
import { StatusPill } from "../components/MandateMeter";
import { dateInputToIso, dateOnly, isoToDateInput, money } from "../format";
import { navigate } from "../router";
import { useStore } from "../store";

const EXAMPLE =
  "Up to $150 this month for my mom's birthday gift and home basics. Ask me before anything over $60. No electronics.";

const modeLabel: Record<Mandate["paypal"]["mode"], string> = {
  authorization: "PayPal authorization hold",
  vault: "PayPal saved payment (vault)",
  per_purchase: "Approve each payment in PayPal",
  mock: "Mock payments (dev only)",
};

export function MandatePage() {
  const { state } = useStore();
  const m = state?.mandate ?? null;
  const [startOver, setStartOver] = useState(false);

  if (!state) return <PageSkeleton />;

  if (m && !startOver && m.status === "active") {
    return <ActiveMandate m={m} remaining={state.remaining} />;
  }
  if (m && !startOver && (m.status === "revoked" || m.status === "expired" || m.status === "exhausted")) {
    return <ActiveMandate m={m} remaining={state.remaining} onNew={() => setStartOver(true)} />;
  }
  // draft or pending_paypal: resume the review form with the saved mandate
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
  const [draft, setDraft] = useState<Mandate | null>(initial);
  const [saved, setSaved] = useState<boolean>(!!initial?.id);
  const [busy, setBusy] = useState<"parse" | "save" | "approve" | null>(null);

  // Adopt the server copy when a different mandate (or status) arrives, not on every state refresh,
  // so edits in progress are not overwritten.
  const initialKey = initial ? `${initial.id}:${initial.status}` : "";
  useEffect(() => {
    if (initial) {
      setDraft(initial);
      setSaved(!!initial.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  const parse = async () => {
    setBusy("parse");
    const out = await run(() => api.parseMandate(text));
    if (out) {
      setDraft(out.mandate);
      setSaved(false);
    }
    setBusy(null);
  };

  const edit = (patch: Partial<Mandate>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setSaved(false);
  };

  const problems = draft ? validate(draft) : [];

  const save = async (): Promise<Mandate | undefined> => {
    if (!draft) return undefined;
    const out = await run(() => api.saveMandate(draft), "Mandate saved");
    if (out) {
      setDraft(out.mandate);
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

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <p className="eyebrow">Step 1 · Mandate</p>
        <h1>Give your agent an allowance</h1>
        <p className="lede">
          Say what the agent may spend, on what, and when it must ask you. You approve it once with PayPal; the agent can
          never spend outside it.
        </p>
      </header>

      <section className="panel">
        <label className="field-label" htmlFor="rule">
          Your rule, in plain language
        </label>
        <textarea id="rule" className="rule-input" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row-end">
          <button className="btn btn-secondary" onClick={parse} disabled={busy !== null || !text.trim()}>
            {busy === "parse" ? <span className="spinner" /> : <Icon name="sparkle" size={16} />}
            {busy === "parse" ? "Drafting…" : "Draft with AI"}
          </button>
        </div>
      </section>

      {draft && (
        <section className="panel review fade-in" aria-label="Review mandate">
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
            <Field label="Total budget" hint="USD, for the whole mandate">
              <MoneyInput value={draft.budget_total} onChange={(v) => edit({ budget_total: v })} />
            </Field>
            <Field label="Ask me above" hint="Per purchase; above this the agent must ask">
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
            <Field label="Expires" hint="End of day, UTC">
              <input
                type="date"
                value={isoToDateInput(draft.expires_at)}
                onChange={(e) => e.target.value && edit({ expires_at: dateInputToIso(e.target.value) })}
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
              Approve with PayPal
            </button>
          </div>
          <p className="fine-print">
            You will sign in to PayPal and approve up to {money(draft.budget_total)}. The agent can then charge only inside
            these rules, and you can revoke it at any time.
          </p>
        </section>
      )}
    </div>
  );
}

function validate(m: Mandate): string[] {
  const out: string[] = [];
  if (!m.title.trim()) out.push("Give the mandate a title.");
  if (!(m.budget_total > 0)) out.push("Budget must be more than $0.");
  if (!Number.isFinite(m.per_purchase_approval_over) || m.per_purchase_approval_over < 0) out.push("Set an ask-first limit of $0 or more.");
  if (m.per_purchase_approval_over > m.budget_total) out.push("The ask-first limit is above the whole budget.");
  if (m.allowed_categories.length === 0) out.push("Allow at least one category.");
  if (Date.parse(m.expires_at) < Date.now()) out.push("The expiry date is in the past.");
  return out;
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

function MoneyInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <span className="money-input">
      <span aria-hidden>$</span>
      <input
        type="number"
        min={0}
        step="0.01"
        inputMode="decimal"
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

function ActiveMandate({ m, remaining, onNew }: { m: Mandate; remaining: number; onNew?: () => void }) {
  const { run } = useStore();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = m.status === "active";
  const spentNet = m.spent - m.refunded;
  const pct = m.budget_total > 0 ? Math.min(1, Math.max(0, spentNet / m.budget_total)) : 0;

  const revoke = async () => {
    setBusy(true);
    await run(() => api.revokeMandate(m.id), "Mandate revoked. The agent can no longer spend.");
    setBusy(false);
    setConfirm(false);
  };

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <p className="eyebrow">Mandate</p>
        <div className="title-row">
          <h1>{m.title}</h1>
          <StatusPill status={m.status} />
        </div>
      </header>

      <section className={`panel mandate-card ${live ? "" : "is-ended"}`}>
        <div className="budget-hero">
          <div>
            <span className="muted small">Left to spend</span>
            <div className="hero-num">{money(live || m.status === "exhausted" ? remaining : 0)}</div>
            <span className="muted small">
              of {money(m.budget_total)} · {money(spentNet)} spent net of refunds
            </span>
          </div>
          <div className="hero-bar" aria-hidden>
            <div className="hero-bar-fill" style={{ width: `${pct * 100}%` }} />
          </div>
        </div>

        <dl className="rules">
          <div>
            <dt>Ask me above</dt>
            <dd>{money(m.per_purchase_approval_over)} per purchase</dd>
          </div>
          <div>
            <dt>Max per item</dt>
            <dd>{m.max_quantity_per_item} units</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>{dateOnly(m.expires_at)}</dd>
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
              <Icon name="bot" size={18} /> Talk to the agent
            </button>
          </div>
        )}
      </section>

      {live ? (
        <section className="panel revoke-panel">
          <div className="revoke-text">
            <h2>
              <Icon name="power" size={18} /> Revoke mandate
            </h2>
            <p>
              Revoking cancels the agent's spending power at PayPal itself (the authorization is voided or the saved
              payment token is deleted). Any purchase the agent tries after that is refused. Purchases already made stay
              in the ledger and can still be refunded.
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
                <Icon name="power" size={16} /> Revoke mandate
              </button>
            </div>
          )}
        </section>
      ) : (
        <section className="panel notice-panel">
          <p>
            {m.status === "revoked"
              ? "This mandate was revoked. The agent has no spending power."
              : m.status === "expired"
                ? "This mandate expired. The agent has no spending power."
                : "The budget is used up. The agent can no longer buy anything under this mandate."}
          </p>
          {onNew && (
            <button className="btn btn-primary" onClick={onNew}>
              Create a new mandate
            </button>
          )}
        </section>
      )}
    </div>
  );
}
