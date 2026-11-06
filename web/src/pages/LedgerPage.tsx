import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
  type RowClassRules,
  type ValueFormatterParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo, useState, useSyncExternalStore } from "react";
import type { AppState, Decision, LedgerActor, LedgerRow, Purchase } from "../../../shared/types";
import { Icon, type IconName } from "../components/Icon";
import { dateTime, money, timeOnly } from "../format";
import { giftPurchase, giftTitle, round2 } from "../giftlist";
import { useStore } from "../store";

ModuleRegistry.registerModules([AllCommunityModule]);

// Ribbon palette (see the tokens at the top of styles.css): ivory rows, cream header, garnet accent.
const gridTheme = themeQuartz.withParams({
  accentColor: "#8e1b2f",
  backgroundColor: "#fffdf8",
  oddRowBackgroundColor: "#fdf9f1",
  rowHoverColor: "#f7efe1",
  selectedRowBackgroundColor: "#f5ebdd",
  fontFamily: "inherit",
  fontSize: 13,
  foregroundColor: "#2a211c",
  headerTextColor: "#5a4e45",
  headerBackgroundColor: "#f7f1e5",
  headerFontWeight: 600,
  borderColor: "#ece3d2",
  rowHeight: 44,
  headerHeight: 40,
  wrapperBorderRadius: 12,
  browserColorScheme: "light",
});

const actorMeta: Record<LedgerActor, { icon: IconName; label: string }> = {
  user: { icon: "user", label: "You" },
  agent: { icon: "bot", label: "Agent" },
  policy: { icon: "scale", label: "Policy" },
  paypal: { icon: "card", label: "PayPal" },
};

const decisionLabel: Record<Decision, string> = { allow: "Allowed", needs_approval: "Ask first", deny: "Denied" };

function ActorCell({ value }: ICellRendererParams<LedgerRow, LedgerActor>) {
  if (!value) return null;
  const m = actorMeta[value];
  return (
    <span className={`actor actor-${value}`}>
      <Icon name={m.icon} size={15} />
      {m.label}
    </span>
  );
}

function DecisionCell({ value }: ICellRendererParams<LedgerRow, Decision | null>) {
  if (!value) return null;
  return <span className={`badge badge-${value}`}>{decisionLabel[value]}</span>;
}

function TextCell({ value }: ICellRendererParams<unknown, string>) {
  return <span title={value ?? ""}>{value}</span>;
}

const moneyFmt = (p: ValueFormatterParams<LedgerRow, number | null>) => (p.value == null ? "" : money(p.value));

const isBad = (r: LedgerRow | undefined) =>
  !!r && (r.decision === "deny" || /deny|block|fail|reject|hijack/.test(r.action));

const rowClassRules: RowClassRules<LedgerRow> = {
  "row-deny": (p) => isBad(p.data),
  "row-wait": (p) => p.data?.decision === "needs_approval",
  // The agent noticed a prompt-injection attempt (amber: a warning, not a block).
  "row-flag": (p) => p.data?.action === "agent.flagged_injection",
  // Red-team simulation rows: same colors, plus a dashed marker so they read as staged.
  "row-sim": (p) => !!p.data?.summary.startsWith("[Red-team simulation]"),
  "row-refund": (p) => !!p.data && /refund/.test(p.data.action) && !isBad(p.data),
};

export function LedgerPage() {
  const { state, refresh } = useStore();
  const recipients = state?.mandate?.recipients;
  const names = useMemo(() => new Map((recipients ?? []).map((r) => [r.id, r.name])), [recipients]);
  const [filter, setFilter] = useState("");
  const [spinning, setSpinning] = useState(false);

  const columns = useMemo<ColDef<LedgerRow>[]>(
    () => [
      {
        field: "ts",
        headerName: "Time",
        width: 118,
        sort: "desc",
        valueFormatter: (p) => (p.value ? timeOnly(p.value) : ""),
        tooltipValueGetter: (p) => (p.value ? dateTime(p.value) : ""),
        getQuickFilterText: (p) => (p.value ? dateTime(p.value) : ""),
      },
      { field: "actor", headerName: "Actor", width: 112, cellRenderer: ActorCell, getQuickFilterText: (p) => (p.value ? actorMeta[p.value as LedgerActor].label : "") },
      {
        field: "recipient_id",
        headerName: "Recipient",
        width: 130,
        valueGetter: (p) => (p.data?.recipient_id ? (names.get(p.data.recipient_id) ?? p.data.recipient_id) : ""),
        cellRenderer: TextCell,
      },
      { field: "action", headerName: "Action", width: 196, cellClass: "mono-cell" },
      { field: "summary", headerName: "Summary", flex: 1, minWidth: 260, cellRenderer: TextCell },
      { field: "amount", headerName: "Amount", width: 110, type: "rightAligned", valueFormatter: moneyFmt },
      { field: "decision", headerName: "Decision", width: 116, cellRenderer: DecisionCell },
      {
        field: "reasons",
        headerName: "Reasons",
        width: 260,
        valueGetter: (p) => p.data?.reasons?.join("; ") ?? "",
        cellRenderer: TextCell,
      },
      { field: "paypal_id", headerName: "PayPal ID", width: 190, cellClass: "mono-cell" },
      { field: "remaining_budget", headerName: "Remaining", width: 118, type: "rightAligned", valueFormatter: moneyFmt },
    ],
    [names],
  );

  const defaultColDef = useMemo<ColDef<LedgerRow>>(() => ({ resizable: true, sortable: true, suppressMovable: false }), []);

  const doRefresh = async () => {
    setSpinning(true);
    await refresh();
    setSpinning(false);
  };

  const m = state?.mandate ?? null;
  const purchases = state?.purchases ?? [];
  const blockedCount = purchases.filter((p) => p.status === "blocked").length;

  return (
    <div className="page">
      <header className="page-head">
        <p className="eyebrow">Step 3 · Ledger</p>
        <h1>Every action, on the record</h1>
        <p className="lede">
          Who got what, and every search, proposal, policy decision and PayPal call behind it, with the budget left after
          each one.
        </p>
      </header>

      <div className="kpis">
        <Kpi label="Spent" value={money(m?.spent ?? 0)} sub="captured by PayPal" />
        <Kpi label="Refunded" value={money(m?.refunded ?? 0)} sub="back to the buyer" />
        <Kpi label="Remaining" value={money(state?.remaining ?? 0)} sub={m ? `of ${money(m.budget_total)}` : "no gift list"} strong />
        <Kpi label="Blocked attempts" value={String(blockedCount)} sub="stopped by policy" tone={blockedCount ? "block" : undefined} />
      </div>

      {state && state.recipients.length > 0 && <GiftListGrid state={state} />}

      <CategorySpend purchases={purchases} />

      <section className="panel grid-panel">
        <div className="grid-toolbar">
          <label className="search-box">
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder="Filter: e.g. deny, paypal, refund"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Quick filter"
            />
          </label>
          <span className="muted small grid-count">{state ? `${state.ledger.length} rows` : ""}</span>
          <button className="btn btn-ghost btn-sm" onClick={doRefresh} disabled={spinning}>
            {spinning ? <span className="spinner" /> : <Icon name="undo" size={15} />} Refresh
          </button>
        </div>
        <div className="grid-wrap">
          <AgGridReact<LedgerRow>
            theme={gridTheme}
            rowData={state?.ledger ?? []}
            columnDefs={columns}
            defaultColDef={defaultColDef}
            getRowId={(p) => p.data.id}
            quickFilterText={filter}
            rowClassRules={rowClassRules}
            loading={!state}
            tooltipShowDelay={300}
            overlayNoRowsTemplate="<span class='muted'>No activity yet. Create a gift list and ask the agent to shop it.</span>"
            animateRows
          />
        </div>
      </section>
    </div>
  );
}

function Kpi({ label, value, sub, strong, tone }: { label: string; value: string; sub: string; strong?: boolean; tone?: "block" }) {
  return (
    <div className={`kpi ${strong ? "kpi-strong" : ""} ${tone ? `kpi-${tone}` : ""}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
}

/** Net spend per category: items of purchases that are currently charged (refunds excluded). */
function CategorySpend({ purchases }: { purchases: Purchase[] }) {
  const rows = useMemo(() => {
    const by = new Map<string, number>();
    for (const p of purchases) {
      if (p.status !== "charged") continue;
      for (const it of p.items) by.set(it.category, (by.get(it.category) ?? 0) + it.price * it.qty);
    }
    return [...by.entries()].sort((a, b) => b[1] - a[1]);
  }, [purchases]);
  const max = rows[0]?.[1] ?? 0;

  return (
    <section className="panel cat-spend" aria-label="Spending by category">
      <h2 className="panel-title">Spending by category</h2>
      {rows.length === 0 ? (
        <p className="muted small">Nothing charged yet.</p>
      ) : (
        <ul className="bars">
          {rows.map(([cat, amt]) => (
            <li key={cat} title={`${cat}: ${money(amt)}`}>
              <span className="bar-label">{cat}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${max ? (amt / max) * 100 : 0}%` }} />
              </span>
              <span className="bar-value">{money(amt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- gift list grid ----------

type GiftState = "bought" | "waiting" | "to_buy" | "blocked" | "refunded" | "declined" | "total";

interface GiftRow {
  id: string;
  recipient: string;
  envelope: number;
  gift: string;
  price: number | null;
  state: GiftState;
  /** Shown in the status cell of the total row. */
  note: string;
  reasons: string;
  capture: string | null;
  /** Demo shipment tracking number registered with PayPal for the capture. */
  tracking: string | null;
  tracker: string | null;
  left: number;
}

const giftState: Record<Exclude<GiftState, "total">, { label: string; cls: string }> = {
  bought: { label: "Bought", cls: "badge-charged" },
  waiting: { label: "Waiting for your OK", cls: "badge-pending_approval" },
  to_buy: { label: "To buy", cls: "badge-to_buy" },
  blocked: { label: "Blocked", cls: "badge-blocked" },
  refunded: { label: "Refunded", cls: "badge-refunded" },
  declined: { label: "Declined", cls: "badge-rejected" },
};

function GiftStateCell({ data }: ICellRendererParams<GiftRow>) {
  if (!data) return null;
  if (data.state === "total") return <span className="muted">{data.note}</span>;
  const s = giftState[data.state];
  return (
    <span className={`badge badge-plain ${s.cls}`} title={data.reasons || undefined}>
      {s.label}
    </span>
  );
}

function giftRows(state: AppState): GiftRow[] {
  return state.recipients.map((st) => {
    const p = giftPurchase(st, state.purchases);
    let s: GiftState = st.state === "bought" ? "bought" : st.state === "waiting_approval" ? "waiting" : "to_buy";
    if (s === "to_buy" && p?.status === "blocked") s = "blocked";
    if (s === "to_buy" && p?.status === "refunded") s = "refunded";
    if (s === "to_buy" && p?.status === "rejected") s = "declined";
    const shown = p && p.status !== "failed" ? p : null;
    return {
      id: st.recipient.id,
      recipient: st.recipient.name,
      envelope: st.recipient.envelope,
      gift: shown ? giftTitle(shown) : "",
      price: shown ? shown.total : null,
      state: s,
      note: "",
      reasons: s === "blocked" || s === "waiting" ? (p?.reasons.join(" ") ?? "") : "",
      capture: p?.status === "charged" || p?.status === "refunded" ? p.paypal.capture_id : null,
      tracking: p?.status === "charged" || p?.status === "refunded" ? (p.shipment?.tracking_number ?? null) : null,
      tracker: p?.status === "charged" || p?.status === "refunded" ? (p.shipment?.tracker_id ?? null) : null,
      left: st.remaining,
    };
  });
}

const giftMoney = (p: ValueFormatterParams<GiftRow, number | null>) => (p.value == null ? "" : money(p.value));

const NARROW = "(max-width: 760px)";
function useNarrow(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia(NARROW);
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    () => window.matchMedia(NARROW).matches,
  );
}

/** One row per person on the gift list, with a pinned total row (AG Grid Community). */
function GiftListGrid({ state }: { state: AppState }) {
  const narrow = useNarrow();
  const rows = useMemo(() => giftRows(state), [state]);
  const total = useMemo<GiftRow[]>(() => {
    const bought = rows.filter((r) => r.state === "bought").length;
    const waiting = rows.filter((r) => r.state === "waiting").length;
    const spent = round2(state.recipients.reduce((s, r) => s + r.spent, 0));
    const shipped = rows.filter((r) => r.state === "bought" && r.tracking).length;
    return [
      {
        id: "total",
        recipient: "Total",
        envelope: round2(rows.reduce((s, r) => s + r.envelope, 0)),
        gift: `${bought} of ${rows.length} bought`,
        price: spent,
        state: "total",
        note: waiting ? `${waiting} waiting` : "",
        reasons: "",
        capture: null,
        tracking: shipped ? `${shipped} shipped` : null,
        tracker: null,
        left: round2(rows.reduce((s, r) => s + r.left, 0)),
      },
    ];
  }, [rows, state.recipients]);

  const columns = useMemo<ColDef<GiftRow>[]>(
    () => [
      { field: "recipient", headerName: "Recipient", width: narrow ? 112 : 150, pinned: "left", cellClass: "strong-cell", cellRenderer: TextCell },
      { field: "envelope", headerName: "Envelope", width: narrow ? 92 : 108, type: "rightAligned", valueFormatter: giftMoney },
      { field: "gift", headerName: "Gift", flex: 1, minWidth: narrow ? 200 : 230, cellRenderer: TextCell },
      {
        field: "price",
        headerName: "Price",
        width: 100,
        type: "rightAligned",
        valueFormatter: giftMoney,
        headerTooltip: "The total row shows what PayPal has captured",
        cellClassRules: { "strike-cell": (p) => p.data?.state === "blocked" || p.data?.state === "declined" || p.data?.state === "refunded" },
      },
      { field: "state", headerName: "Status", width: 168, cellRenderer: GiftStateCell, tooltipValueGetter: (p) => p.data?.reasons || "" },
      { field: "capture", headerName: "PayPal capture", width: 184, cellClass: "mono-cell" },
      {
        field: "tracking",
        headerName: "Tracking",
        width: 160,
        cellClass: (p) => (p.node.rowPinned ? "" : "mono-cell"),
        headerTooltip: "Demo shipment registered with PayPal for the capture (carrier: Ribbon demo shipping)",
        tooltipValueGetter: (p) => (p.data?.tracker ? `PayPal tracker ${p.data.tracker}` : ""),
      },
      { field: "left", headerName: "Left", width: 96, type: "rightAligned", valueFormatter: giftMoney, cellClass: "strong-cell" },
    ],
    [narrow],
  );

  const rowClassRules = useMemo<RowClassRules<GiftRow>>(
    () => ({
      "row-total": (p) => !!p.node.rowPinned,
      "row-wait": (p) => !p.node.rowPinned && p.data?.state === "waiting",
      "row-deny": (p) => !p.node.rowPinned && p.data?.state === "blocked",
    }),
    [],
  );

  return (
    <section className="panel grid-panel gift-grid" aria-label="Gift list">
      <div className="gift-grid-head">
        <h2 className="panel-title">Gift list</h2>
        <span className="muted small">One envelope per person; Left is the envelope minus what PayPal captured.</span>
      </div>
      <AgGridReact<GiftRow>
        theme={gridTheme}
        rowData={rows}
        pinnedBottomRowData={total}
        columnDefs={columns}
        defaultColDef={{ resizable: true, sortable: true }}
        getRowId={(p) => p.data.id}
        rowClassRules={rowClassRules}
        domLayout="autoHeight"
        tooltipShowDelay={300}
        suppressCellFocus
      />
    </section>
  );
}
