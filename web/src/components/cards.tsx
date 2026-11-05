import { useState, type ReactNode } from "react";
import type {
  BuyGiftPlanOutput,
  GetMandateOutput,
  ListPurchasesOutput,
  Product,
  Purchase,
  PurchaseItem,
  PurchaseStatus,
  ReportSuspiciousOutput,
  RequestRefundOutput,
  SearchGiftsOutput,
  SearchProductsOutput,
} from "../../../shared/types";
import { api } from "../api";
import { dateTime, money } from "../format";
import { giftTitle, recipientName } from "../giftlist";
import { useStore } from "../store";
import { Icon, iconForCategory } from "./Icon";

// ---------- products ----------

function Thumb({ src, category, alt, small }: { src: string | null; category: string; alt: string; small?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return <img className={`thumb ${small ? "thumb-sm" : ""}`} src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return (
    <div className={`thumb thumb-ph cat-${category} ${small ? "thumb-sm" : ""}`} aria-hidden>
      <Icon name={iconForCategory(category)} size={small ? 22 : 30} />
    </div>
  );
}

export function CategoryChip({ category, low }: { category: string; low?: boolean }) {
  return (
    <span className={`chip chip-cat ${low ? "chip-low" : ""}`} title={low ? "Category is uncertain, so a purchase would need your approval" : undefined}>
      {category}
      {low && <span className="chip-q">?</span>}
    </span>
  );
}

function ProductCard({ p }: { p: Product }) {
  const title = p.url ? (
    <a href={p.url} target="_blank" rel="noopener noreferrer">
      {p.title}
    </a>
  ) : (
    p.title
  );
  return (
    <article className="product">
      <Thumb src={p.image_url} category={p.category} alt="" />
      <div className="product-body">
        <h4 className="product-title">{title}</h4>
        <div className="product-merchant">{p.merchant}</div>
        {p.description && <p className="product-desc">{p.description}</p>}
        <div className="product-foot">
          <span className="product-price">{money(p.price)}</span>
          <CategoryChip category={p.category} low={p.category_confidence === "low"} />
        </div>
        {p.category_confidence === "low" && <div className="product-note">Uncertain category: buying it needs your OK</div>}
      </div>
    </article>
  );
}

export function ProductStrip({ output }: { output: SearchProductsOutput }) {
  const n = output.products.length;
  return (
    <section className="tool-card products-card" aria-label={`Search results for ${output.query}`}>
      <header className="tool-head">
        <Icon name="search" />
        <span>
          Searched <q>{output.query}</q> · {n} result{n === 1 ? "" : "s"}
        </span>
        <span className="tool-source">{output.source === "channel3" ? "Channel3" : "Demo catalog"}</span>
      </header>
      {n === 0 ? (
        <p className="muted pad">No products matched.</p>
      ) : (
        <div className="product-strip" tabIndex={0}>
          {output.products.map((p) => (
            <ProductCard key={p.id} p={p} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- purchases ----------

function Items({ items }: { items: PurchaseItem[] }) {
  return (
    <ul className="items">
      {items.map((it) => (
        <li key={it.product_id + it.qty}>
          <span className="item-title">
            {it.title}
            <span className="item-meta">
              {it.merchant} · {it.category}
            </span>
          </span>
          <span className="item-qty">×{it.qty}</span>
          <span className="item-price">{money(it.price * it.qty)}</span>
        </li>
      ))}
    </ul>
  );
}

function Total({ total, label = "Total", strike }: { total: number; label?: string; strike?: boolean }) {
  return (
    <div className="total-row">
      <span>{label}</span>
      <strong className={strike ? "strike" : undefined}>{money(total)}</strong>
    </div>
  );
}

function Rationale({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="rationale">
      <span className="rationale-label">Why this one</span>
      <p>{text}</p>
    </div>
  );
}

function PaypalId({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="pp-id">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

/** The name of the person a purchase is for, or null on a legacy purchase. */
function useForName(p: Purchase): string | null {
  const { state } = useStore();
  return recipientName(state, p.recipient_id);
}

function Receipt({ p }: { p: Purchase }) {
  const { run } = useStore();
  const name = useForName(p);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const refunded = p.status === "refunded";

  const refund = async () => {
    setBusy(true);
    await run(() => api.refundPurchase(p.id), `Refunded ${money(p.total)}`);
    setBusy(false);
    setConfirm(false);
  };

  return (
    <section className={`tool-card purchase-card receipt ${refunded ? "is-refunded" : ""}`}>
      <header className="card-banner banner-ok">
        <Icon name={refunded ? "undo" : "receipt"} />
        <div>
          <strong>
            {refunded
              ? name
                ? `Bought for ${name}, then refunded`
                : "Purchased, then refunded"
              : name
                ? `Bought for ${name}`
                : "Purchased inside your gift list"}
          </strong>
          <span>
            {refunded
              ? "The money went back to the buyer's PayPal."
              : `${name ? `Inside ${name}'s envelope. ` : ""}${p.decision === "needs_approval" ? "You approved it; paid with PayPal." : "Paid with PayPal. No approval was needed."}`}
          </span>
        </div>
        {refunded && <span className="stamp">Refunded</span>}
      </header>
      <div className="card-body">
        <Items items={p.items} />
        <Total total={p.total} strike={refunded} />
        <Rationale text={p.rationale} />
        <div className="pp-ids">
          <PaypalId label="PayPal capture" value={p.paypal.capture_id} />
          <PaypalId label="PayPal refund" value={p.paypal.refund_id} />
        </div>
      </div>
      {p.status === "charged" && (
        <footer className="card-actions">
          {confirm ? (
            <>
              <span className="muted small">Refund {money(p.total)} through PayPal?</span>
              <button className="btn btn-ghost" onClick={() => setConfirm(false)} disabled={busy}>
                Keep it
              </button>
              <button className="btn btn-secondary" onClick={refund} disabled={busy}>
                {busy ? <span className="spinner" /> : <Icon name="undo" size={16} />}
                Confirm refund
              </button>
            </>
          ) : (
            <button className="btn btn-ghost" onClick={() => setConfirm(true)}>
              <Icon name="undo" size={16} /> Refund
            </button>
          )}
        </footer>
      )}
    </section>
  );
}

function Approval({ p }: { p: Purchase }) {
  const { run } = useStore();
  const name = useForName(p);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const decided = p.status === "rejected";
  // per_purchase rail: the payment itself waits for the buyer inside PayPal.
  const inPaypal = !decided && !!p.paypal.approve_url;

  const act = async (which: "approve" | "reject") => {
    setBusy(which);
    if (which === "approve") await run(() => api.approvePurchase(p.id), `Approved and paid ${money(p.total)}`);
    else await run(() => api.rejectPurchase(p.id), "Declined. Nothing was charged.");
    setBusy(null);
  };

  return (
    <section className={`tool-card purchase-card approval ${decided ? "is-decided" : ""}`}>
      <header className="card-banner banner-wait">
        <Icon name={decided ? "x" : "clock"} />
        <div>
          <strong>
            {decided
              ? name
                ? `You declined ${name}'s gift`
                : "You declined this purchase"
              : `Waiting for your OK${name ? ` on ${name}'s gift` : ""}${inPaypal ? " in PayPal" : ""}`}
          </strong>
          <span>
            {decided
              ? "Nothing was charged."
              : inPaypal
                ? "Nothing is charged until you approve this payment in PayPal."
                : "Nothing is charged until you decide."}
          </span>
        </div>
      </header>
      <div className="card-body">
        <Items items={p.items} />
        <Total total={p.total} strike={decided} />
        {p.reasons.length > 0 && (
          <ul className="reasons reasons-wait">
            {p.reasons.map((r) => (
              <li key={r}>
                <Icon name="scale" size={16} />
                {r}
              </li>
            ))}
          </ul>
        )}
        <Rationale text={p.rationale} />
      </div>
      {!decided && (
        <footer className="card-actions">
          <button className="btn btn-ghost" onClick={() => act("reject")} disabled={busy !== null}>
            {busy === "reject" ? <span className="spinner" /> : <Icon name="x" size={16} />} Reject
          </button>
          {inPaypal ? (
            <a className="btn btn-paypal" href={p.paypal.approve_url!} target="_blank" rel="noopener noreferrer">
              Approve this payment in PayPal <Icon name="external" size={16} />
            </a>
          ) : (
            <button className="btn btn-primary" onClick={() => act("approve")} disabled={busy !== null}>
              {busy === "approve" ? <span className="spinner" /> : <Icon name="check" size={16} />} Approve {money(p.total)}
            </button>
          )}
        </footer>
      )}
    </section>
  );
}

function Blocked({ p }: { p: Purchase }) {
  const name = useForName(p);
  return (
    <section className="tool-card purchase-card blocked" role="status">
      <header className="card-banner banner-block">
        <span className="block-shield">
          <Icon name="shieldX" size={22} />
        </span>
        <div>
          <strong>Blocked by your gift list</strong>
          <span>Nothing was charged. The agent cannot override this.</span>
        </div>
      </header>
      <div className="card-body">
        <ul className="reasons reasons-block">
          {p.reasons.map((r) => (
            <li key={r}>
              <Icon name="x" size={16} />
              {r}
            </li>
          ))}
        </ul>
        <div className="attempt">
          <span className="attempt-label">The agent tried{name ? `, for ${name}` : ""}</span>
          <Items items={p.items} />
          <Total total={p.total} label="Would have cost" strike />
          {p.rationale && (
            <p className="attempt-why">
              Agent's stated reason: <q>{p.rationale}</q>
            </p>
          )}
        </div>
      </div>
      <footer className="card-foot">
        <Icon name="shieldCheck" size={15} /> Checked in code by the policy engine before any PayPal call.
      </footer>
    </section>
  );
}

function Failed({ p }: { p: Purchase }) {
  const name = useForName(p);
  return (
    <section className="tool-card purchase-card failed">
      <header className="card-banner banner-fail">
        <Icon name="alert" />
        <div>
          <strong>Payment did not go through{name ? ` for ${name}` : ""}</strong>
          <span>Nothing was charged.</span>
        </div>
      </header>
      <div className="card-body">
        <Items items={p.items} />
        {p.error && <p className="error-text">{p.error}</p>}
      </div>
    </section>
  );
}

/** Shows the latest known status of a purchase (state refreshes after approve/refund). */
export function PurchaseCard({ purchase }: { purchase: Purchase }) {
  const { state } = useStore();
  const p = state?.purchases.find((x) => x.id === purchase.id) ?? purchase;
  const byStatus: Record<PurchaseStatus, ReactNode> = {
    charged: <Receipt p={p} />,
    refunded: <Receipt p={p} />,
    pending_approval: <Approval p={p} />,
    rejected: <Approval p={p} />,
    blocked: <Blocked p={p} />,
    failed: <Failed p={p} />,
  };
  return <>{byStatus[p.status] ?? <Failed p={p} />}</>;
}

export function RefundCard({ output }: { output: RequestRefundOutput }) {
  const { state } = useStore();
  const p = state?.purchases.find((x) => x.id === output.purchase.id) ?? output.purchase;
  const name = recipientName(state, p.recipient_id);
  const envelopeLeft = state?.recipients.find((r) => r.recipient.id === p.recipient_id)?.remaining;
  if (p.status !== "refunded") {
    return (
      <section className="tool-card purchase-card failed">
        <header className="card-banner banner-fail">
          <Icon name="alert" />
          <div>
            <strong>Refund not completed</strong>
            <span>{p.error ?? `The purchase is ${p.status.replace("_", " ")}.`}</span>
          </div>
        </header>
      </section>
    );
  }
  return (
    <section className="tool-card purchase-card refund">
      <header className="card-banner banner-refund">
        <Icon name="undo" />
        <div>
          <strong>
            Refund issued: {money(p.total)}
            {name ? ` for ${name}` : ""}
          </strong>
          <span>
            Back to the buyer's PayPal.{" "}
            {name && envelopeLeft != null ? `${name}'s envelope has ${money(envelopeLeft)} again; ` : ""}
            {name ? "budget" : "Budget"} left now {money(output.remaining)}.
          </span>
        </div>
      </header>
      <div className="card-body">
        <Items items={p.items} />
        <div className="pp-ids">
          <PaypalId label="PayPal refund" value={p.paypal.refund_id} />
          <PaypalId label="Original capture" value={p.paypal.capture_id} />
        </div>
      </div>
    </section>
  );
}

/** Defence layer 1: the model noticed product text that tries to instruct it and reported it. */
export function FlaggedCard({ output }: { output: ReportSuspiciousOutput }) {
  const reason = output.reason.length > 220 ? `${output.reason.slice(0, 217)}…` : output.reason;
  return (
    <section className="tool-card flag-card" role="status">
      <header className="card-banner banner-flag">
        <Icon name="alert" />
        <div>
          <strong>Agent flagged suspicious product text</strong>
          <span>
            {output.product_title ? (
              <>
                <q>{output.product_title}</q> tries to give the agent orders. The agent skipped it.
              </>
            ) : (
              "A listing tries to give the agent orders. The agent skipped it."
            )}
          </span>
        </div>
      </header>
      {reason && (
        <div className="card-body">
          <p className="flag-reason">
            <span className="rationale-label">Agent's note</span>
            {reason}
          </p>
        </div>
      )}
      <footer className="card-foot">
        <Icon name="shieldCheck" size={15} /> Logged in the ledger. If a fooled agent tried anyway, your gift list would still block it.
      </footer>
    </section>
  );
}

export function MandateCheckCard({ output }: { output: GetMandateOutput }) {
  const m = output.mandate;
  const people = output.recipients ?? [];
  const done = people.filter((r) => r.state === "bought").length;
  return (
    <div className="tool-mini">
      <Icon name="shieldCheck" size={16} />
      {m ? (
        <span>
          Checked the gift list: <strong>{money(output.remaining)}</strong> left of {money(m.budget_total)}
          {people.length > 0 ? ` · ${done} of ${people.length} bought` : ""} · {m.status}
        </span>
      ) : (
        <span>Checked the gift list: none is active</span>
      )}
    </div>
  );
}

export function PurchasesListCard({ output }: { output: ListPurchasesOutput }) {
  const { state } = useStore();
  if (output.purchases.length === 0) {
    return (
      <div className="tool-mini">
        <Icon name="list" size={16} /> No purchases yet.
      </div>
    );
  }
  return (
    <section className="tool-card">
      <header className="tool-head">
        <Icon name="list" />
        <span>Purchases on this gift list</span>
      </header>
      <ul className="plist">
        {output.purchases.map((x) => {
          const p = state?.purchases.find((y) => y.id === x.id) ?? x;
          return (
            <li key={p.id}>
              <span className="plist-title">
                {p.items.map((i) => i.title).join(", ")}
                {p.recipient_id && <span className="plist-for"> · for {recipientName(state, p.recipient_id) ?? "someone"}</span>}
              </span>
              <span className={`badge badge-${p.status}`}>{p.status.replace("_", " ")}</span>
              <span className="plist-amt">{money(p.total)}</span>
              <span className="plist-time muted">{dateTime(p.created_at)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------- gift list ----------

function GiftTile({ p, note }: { p: Product; note: string | null }) {
  const title = p.url ? (
    <a href={p.url} target="_blank" rel="noopener noreferrer">
      {p.title}
    </a>
  ) : (
    p.title
  );
  return (
    <article className={`gift-tile ${note ? "is-out" : ""}`} title={p.description || undefined}>
      <Thumb src={p.image_url} category={p.category} alt="" small />
      <div className="gift-tile-body">
        <h4 className="gift-tile-title">{title}</h4>
        <div className="gift-tile-meta">
          <span className="gift-tile-price">{money(p.price)}</span>
          <CategoryChip category={p.category} low={p.category_confidence === "low"} />
        </div>
        {note && <div className="gift-tile-note">{note}</div>}
      </div>
    </article>
  );
}

/** search_gifts: one strip of options per person, with the person's envelope. */
export function GiftSearchCard({ output }: { output: SearchGiftsOutput }) {
  const { state } = useStore();
  const m = state?.mandate ?? null;
  const people = output.results.length;
  const options = output.results.reduce((n, r) => n + r.products.length, 0);
  return (
    <section className="tool-card gift-search" aria-label={`Gift search for ${people} people`}>
      <header className="tool-head">
        <Icon name="search" />
        <span>
          Searched gifts for {people} {people === 1 ? "person" : "people"} · {options} option{options === 1 ? "" : "s"}
        </span>
        <span className="tool-source">{output.source === "channel3" ? "Channel3" : "Demo catalog"}</span>
      </header>
      <div className="gs-list">
        {output.results.map((r) => {
          const envelope = m?.recipients.find((x) => x.id === r.recipient_id)?.envelope ?? null;
          return (
            <div className="gs-person" key={r.recipient_id}>
              <div className="gs-head">
                <span className="gs-avatar" aria-hidden>
                  {r.recipient_name.slice(0, 1).toUpperCase()}
                </span>
                <strong className="gs-name">{r.recipient_name}</strong>
                {envelope != null && <span className="gs-env">{money(envelope)} envelope</span>}
                <span className="gs-query">
                  <q>{r.query}</q>
                </span>
              </div>
              {r.products.length === 0 ? (
                <p className="muted small gs-empty">No products matched.</p>
              ) : (
                <div className="gs-strip" tabIndex={0} aria-label={`Options for ${r.recipient_name}`}>
                  {r.products.map((p) => {
                    const note = m?.blocked_categories.includes(p.category)
                      ? `${p.category} is blocked`
                      : envelope != null && p.price > envelope
                        ? "Over the envelope"
                        : null;
                    return <GiftTile key={p.id} p={p} note={note} />;
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

type PlanKind = "bought" | "waiting" | "blocked" | "declined" | "refunded" | "failed";

const planBadge: Record<PlanKind, { label: string; cls: string }> = {
  bought: { label: "Bought", cls: "badge-charged" },
  waiting: { label: "Waiting for your OK", cls: "badge-pending_approval" },
  blocked: { label: "Blocked", cls: "badge-blocked" },
  declined: { label: "Declined", cls: "badge-rejected" },
  refunded: { label: "Refunded", cls: "badge-refunded" },
  failed: { label: "Not bought", cls: "badge-failed" },
};

function planKind(p: Purchase | null): PlanKind {
  if (!p) return "failed";
  const map: Record<PurchaseStatus, PlanKind> = {
    charged: "bought",
    pending_approval: "waiting",
    blocked: "blocked",
    rejected: "declined",
    refunded: "refunded",
    failed: "failed",
  };
  return map[p.status] ?? "failed";
}

export function DecideButtons({ p }: { p: Purchase }) {
  const { run } = useStore();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const act = async (which: "approve" | "reject") => {
    setBusy(which);
    if (which === "approve") await run(() => api.approvePurchase(p.id), `Approved and paid ${money(p.total)}`);
    else await run(() => api.rejectPurchase(p.id), "Declined. Nothing was charged.");
    setBusy(null);
  };
  return (
    <div className="gp-actions">
      <button className="btn btn-ghost btn-sm" onClick={() => act("reject")} disabled={busy !== null}>
        {busy === "reject" ? <span className="spinner" /> : <Icon name="x" size={15} />} Reject
      </button>
      {p.paypal.approve_url ? (
        <a className="btn btn-paypal btn-sm" href={p.paypal.approve_url} target="_blank" rel="noopener noreferrer">
          Approve in PayPal <Icon name="external" size={15} />
        </a>
      ) : (
        <button className="btn btn-primary btn-sm" onClick={() => act("approve")} disabled={busy !== null}>
          {busy === "approve" ? <span className="spinner" /> : <Icon name="check" size={15} />} Approve {money(p.total)}
        </button>
      )}
    </div>
  );
}

/** buy_gift_plan: one row per person with the gift, its status and the envelope left. */
export function GiftPlanCard({ output }: { output: BuyGiftPlanOutput }) {
  const { state } = useStore();
  const sameList = (mandateId: string | undefined) => !!state?.mandate && (!mandateId || state.mandate.id === mandateId);
  const rows = output.results.map((r) => {
    const p = r.purchase ? (state?.purchases.find((x) => x.id === r.purchase!.id) ?? r.purchase) : null;
    const live = sameList(r.purchase?.mandate_id) ? state?.recipients.find((x) => x.recipient.id === r.recipient_id) : undefined;
    const st = live ?? output.recipients.find((x) => x.recipient.id === r.recipient_id);
    return { r, p, st, kind: planKind(p) };
  });
  const count = (k: PlanKind) => rows.filter((x) => x.kind === k).length;
  const bought = count("bought");
  const waiting = count("waiting");
  const stopped = count("blocked") + count("failed");
  const firstMandate = output.results.find((r) => r.purchase)?.purchase?.mandate_id;
  const left = sameList(firstMandate) && state ? state.remaining : output.remaining;
  const total = sameList(firstMandate) ? state?.mandate?.budget_total : undefined;
  const tone = waiting > 0 ? "banner-wait" : stopped > 0 ? "banner-plan" : "banner-ok";
  const extra = [waiting ? `${waiting} waiting for your OK` : "", stopped ? `${stopped} blocked or not bought` : ""].filter(Boolean);

  return (
    <section className="tool-card gift-plan" aria-label="Gift plan">
      <header className={`card-banner ${tone}`}>
        <Icon name="gift" />
        <div>
          <strong>
            Gift plan: {bought} of {rows.length} bought
          </strong>
          <span>
            {extra.length ? `${extra.join(" · ")}. ` : ""}Each gift was checked in code against its own envelope.
          </span>
        </div>
      </header>
      <ul className="gp-rows">
        {rows.map(({ r, p, st, kind }) => (
          <li key={r.recipient_id} className={`gp-row gp-${kind}`}>
            <div className="gp-who">
              <strong>{r.recipient_name}</strong>
              {st && (
                <span className="gp-env">
                  {money(st.remaining)} left of {money(st.recipient.envelope)}
                </span>
              )}
            </div>
            <div className="gp-gift">{p ? giftTitle(p) : <span className="muted">No gift bought</span>}</div>
            <div className={`gp-price ${kind === "blocked" || kind === "declined" ? "strike" : ""}`}>{p ? money(p.total) : "—"}</div>
            <div className="gp-status">
              <span className={`badge badge-plain ${planBadge[kind].cls}`}>{planBadge[kind].label}</span>
            </div>
            <div className="gp-detail">
              {kind === "bought" && p && <PaypalId label="PayPal capture" value={p.paypal.capture_id} />}
              {kind === "refunded" && p && <PaypalId label="PayPal refund" value={p.paypal.refund_id} />}
              {kind === "waiting" && p && (
                <>
                  {p.reasons.length > 0 && <p className="gp-why gp-why-wait">{p.reasons.join(" ")}</p>}
                  <DecideButtons p={p} />
                </>
              )}
              {kind === "blocked" && p && (
                <ul className="gp-reasons">
                  {p.reasons.map((x) => (
                    <li key={x}>
                      <Icon name="x" size={14} />
                      {x}
                    </li>
                  ))}
                </ul>
              )}
              {kind === "declined" && <p className="gp-why">You declined it. Nothing was charged.</p>}
              {kind === "failed" && <p className="gp-why gp-why-fail">{p?.error ?? r.error ?? "Not bought."}</p>}
            </div>
          </li>
        ))}
      </ul>
      <footer className="gp-foot">
        <span>Left on your PayPal approval</span>
        <strong>
          {money(left)}
          {total != null && <span className="muted"> of {money(total)}</span>}
        </strong>
      </footer>
    </section>
  );
}

// ---------- tool states ----------

const pendingLabel: Record<string, string> = {
  search_products: "Searching products",
  propose_purchase: "Checking the gift-list rules",
  request_refund: "Asking PayPal for a refund",
  get_mandate: "Reading your gift list",
  list_purchases: "Looking up purchases",
  report_suspicious_content: "Flagging a suspicious listing",
  search_gifts: "Searching gifts for everyone on the list",
  buy_gift_plan: "Buying each gift inside its envelope",
};

export function ToolPending({ name }: { name: string }) {
  return (
    <div className="tool-mini tool-pending" role="status">
      <span className="spinner" />
      <span>{pendingLabel[name] ?? `Running ${name.replace(/_/g, " ")}`}…</span>
    </div>
  );
}

export function ToolError({ name, text }: { name: string; text: string }) {
  return (
    <div className="tool-mini tool-error" role="alert">
      <Icon name="alert" size={16} />
      <span>
        {pendingLabel[name] ?? name.replace(/_/g, " ")} failed: {text}
      </span>
    </div>
  );
}

export function GenericToolCard({ name, output }: { name: string; output: unknown }) {
  return (
    <details className="tool-mini tool-generic">
      <summary>
        <Icon name="sparkle" size={16} /> Used {name.replace(/_/g, " ")}
      </summary>
      <pre>{JSON.stringify(output, null, 2)}</pre>
    </details>
  );
}
