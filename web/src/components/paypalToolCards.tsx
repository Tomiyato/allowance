// Cards for the read-only PayPal Agent Toolkit tools (get_order, get_refund, get_shipment_tracking).
// Built only from existing classes and tokens in styles.css.
import type { PayPalCheckOutput, PayPalRecord, PayPalToolkitToolName } from "../../../shared/types";
import { dateTime, money } from "../format";
import { Icon } from "./Icon";

export const PAYPAL_TOOLKIT_TOOLS: readonly PayPalToolkitToolName[] = ["get_order", "get_refund", "get_shipment_tracking"];

export const isPayPalToolkitTool = (name: string): name is PayPalToolkitToolName =>
  (PAYPAL_TOOLKIT_TOOLS as readonly string[]).includes(name);

const LABEL = "Checked with PayPal";
const SOURCE = "Agent Toolkit · read-only";

const pending: Record<PayPalToolkitToolName, string> = {
  get_order: "Checking the order in PayPal's records",
  get_refund: "Checking the refund in PayPal's records",
  get_shipment_tracking: "Checking shipping in PayPal's records",
};

const kindLabel: Record<PayPalRecord["kind"], string> = {
  order: "Order",
  authorization: "Authorization",
  capture: "Captured",
  refund: "Refund",
  tracker: "Shipment",
};

/** Map PayPal's status words onto the existing badge colours. */
function badgeClass(status: string): string {
  const s = status.toUpperCase();
  if (/REFUND/.test(s)) return "badge-refunded";
  if (/^(COMPLETED|CAPTURED|SHIPPED|DELIVERED)$/.test(s)) return "badge-charged";
  if (/^(VOIDED|DENIED|DECLINED|FAILED|CANCELLED|EXPIRED)$/.test(s)) return "badge-blocked";
  if (/^(PENDING|ON_HOLD|IN_PROGRESS)$/.test(s)) return "badge-pending_approval";
  return "badge-to_buy";
}

const statusText = (s: string) => s.toLowerCase().replace(/_/g, " ");

export function PayPalCheckPending({ name }: { name: PayPalToolkitToolName }) {
  return (
    <div className="tool-mini tool-pending" role="status">
      <span className="spinner" />
      <span>{pending[name]}… (PayPal Agent Toolkit, read-only)</span>
    </div>
  );
}

export function PayPalCheckError({ text }: { text: string }) {
  return (
    <div className="tool-mini tool-error" role="alert">
      <Icon name="alert" size={16} />
      <span>
        {LABEL} (Agent Toolkit, read-only): {text}
      </span>
    </div>
  );
}

const lookupLabel: Record<PayPalToolkitToolName, string> = {
  get_order: "PayPal order",
  get_refund: "PayPal refund",
  get_shipment_tracking: "Shipping for capture",
};

function Row({ r }: { r: PayPalRecord }) {
  const detail = [r.gift, r.note, r.time ? dateTime(r.time) : null].filter(Boolean).join(" · ");
  return (
    <li>
      <span className="plist-title">
        {kindLabel[r.kind]}
        {r.recipient_name && <span className="plist-for"> · for {r.recipient_name}</span>}
      </span>
      <span className={`badge ${badgeClass(r.status)}`}>{statusText(r.status)}</span>
      <span className="plist-amt">{r.amount != null ? money(r.amount) : ""}</span>
      <span className="plist-time muted">
        <code>{r.id}</code>
        {detail && ` · ${detail}`}
      </span>
    </li>
  );
}

/** A toolkit lookup result: PayPal's own records, each matched to the person on the list it belongs to. */
export function PayPalCheckCard({ output }: { output: PayPalCheckOutput }) {
  if (!output.ok) return <PayPalCheckError text={output.error ?? "PayPal returned no record."} />;
  // The order row is the headline; list what PayPal recorded under it.
  const order = output.tool === "get_order" ? output.records.find((r) => r.kind === "order") : undefined;
  const rows = output.tool === "get_order" ? output.records.filter((r) => r.kind !== "order") : output.records;
  return (
    <section className="tool-card" aria-label={`${LABEL}: ${lookupLabel[output.tool]} ${output.lookup_id}`}>
      <header className="tool-head">
        <Icon name="shieldCheck" />
        <span>
          <strong>{LABEL}</strong>
        </span>
        <span className="tool-source">{SOURCE}</span>
      </header>
      <div className="pp-ids" style={{ alignItems: "center", padding: "10px 14px 0" }}>
        <div className="pp-id">
          <span>{lookupLabel[output.tool]}</span>
          <code>{output.lookup_id}</code>
        </div>
        {order && <span className={`badge ${badgeClass(order.status)}`}>{statusText(order.status)}</span>}
        {order?.amount != null && <span className="muted small">{money(order.amount)} {/AUTHORIZE/.test(order.note ?? "") ? "authorized" : "ordered"}</span>}
      </div>
      {rows.length === 0 ? (
        <p className="muted small" style={{ margin: 0, padding: "10px 14px" }}>
          {output.tool === "get_shipment_tracking" ? "PayPal has no shipment tracking for this payment yet." : "PayPal returned no payments under this id."}
        </p>
      ) : (
        <ul className="plist">
          {rows.map((r) => (
            <Row key={`${r.kind}-${r.id}`} r={r} />
          ))}
        </ul>
      )}
      <footer className="card-foot">
        <Icon name="shieldCheck" size={15} /> PayPal's own record, read through the PayPal Agent Toolkit. Read-only: nothing was charged or changed.
      </footer>
    </section>
  );
}
