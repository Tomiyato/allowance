import { useState, type ReactNode } from "react";
import type {
  GetMandateOutput,
  ListPurchasesOutput,
  Product,
  Purchase,
  PurchaseItem,
  PurchaseStatus,
  ReportSuspiciousOutput,
  RequestRefundOutput,
  SearchProductsOutput,
} from "../../../shared/types";
import { api } from "../api";
import { dateTime, money } from "../format";
import { useStore } from "../store";
import { Icon, iconForCategory } from "./Icon";

// ---------- products ----------

function Thumb({ src, category, alt }: { src: string | null; category: string; alt: string }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return <img className="thumb" src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return (
    <div className={`thumb thumb-ph cat-${category}`} aria-hidden>
      <Icon name={iconForCategory(category)} size={30} />
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

function Receipt({ p }: { p: Purchase }) {
  const { run } = useStore();
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
          <strong>{refunded ? "Purchased, then refunded" : "Purchased inside your mandate"}</strong>
          <span>{refunded ? "The money went back to the buyer's PayPal." : "Paid with PayPal. No approval was needed."}</span>
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
          <strong>{decided ? "You declined this purchase" : inPaypal ? "Waiting for your OK in PayPal" : "Waiting for your OK"}</strong>
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
  return (
    <section className="tool-card purchase-card blocked" role="status">
      <header className="card-banner banner-block">
        <span className="block-shield">
          <Icon name="shieldX" size={22} />
        </span>
        <div>
          <strong>Blocked by your mandate</strong>
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
          <span className="attempt-label">The agent tried</span>
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
  return (
    <section className="tool-card purchase-card failed">
      <header className="card-banner banner-fail">
        <Icon name="alert" />
        <div>
          <strong>Payment did not go through</strong>
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
          <strong>Refund issued: {money(p.total)}</strong>
          <span>Back to the buyer's PayPal. Budget left now {money(output.remaining)}.</span>
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
        <Icon name="shieldCheck" size={15} /> Logged in the ledger. If a fooled agent tried anyway, your mandate would still block it.
      </footer>
    </section>
  );
}

export function MandateCheckCard({ output }: { output: GetMandateOutput }) {
  const m = output.mandate;
  return (
    <div className="tool-mini">
      <Icon name="shieldCheck" size={16} />
      {m ? (
        <span>
          Checked the mandate: <strong>{money(output.remaining)}</strong> left of {money(m.budget_total)} · {m.status}
        </span>
      ) : (
        <span>Checked the mandate: none is active</span>
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
        <span>Purchases under this mandate</span>
      </header>
      <ul className="plist">
        {output.purchases.map((x) => {
          const p = state?.purchases.find((y) => y.id === x.id) ?? x;
          return (
            <li key={p.id}>
              <span className="plist-title">{p.items.map((i) => i.title).join(", ")}</span>
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

// ---------- tool states ----------

const pendingLabel: Record<string, string> = {
  search_products: "Searching products",
  propose_purchase: "Checking your mandate",
  request_refund: "Asking PayPal for a refund",
  get_mandate: "Reading your mandate",
  list_purchases: "Looking up purchases",
  report_suspicious_content: "Flagging a suspicious listing",
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
