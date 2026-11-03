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
import { useMemo, useState } from "react";
import type { Decision, LedgerActor, LedgerRow, Purchase } from "../../../shared/types";
import { Icon, type IconName } from "../components/Icon";
import { dateTime, money, timeOnly } from "../format";
import { useStore } from "../store";

ModuleRegistry.registerModules([AllCommunityModule]);

const gridTheme = themeQuartz.withParams({
  accentColor: "#0f766e",
  fontFamily: "inherit",
  fontSize: 13,
  foregroundColor: "#13293a",
  headerTextColor: "#4a5b6a",
  headerBackgroundColor: "#f5f7f9",
  headerFontWeight: 600,
  borderColor: "#e2e8ee",
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

function TextCell({ value }: ICellRendererParams<LedgerRow, string>) {
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
    [],
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
        <p className="lede">Searches, proposals, policy decisions and PayPal calls, with the budget left after each one.</p>
      </header>

      <div className="kpis">
        <Kpi label="Spent" value={money(m?.spent ?? 0)} sub="captured by PayPal" />
        <Kpi label="Refunded" value={money(m?.refunded ?? 0)} sub="back to the buyer" />
        <Kpi label="Remaining" value={money(state?.remaining ?? 0)} sub={m ? `of ${money(m.budget_total)}` : "no mandate"} strong />
        <Kpi label="Blocked attempts" value={String(blockedCount)} sub="stopped by policy" tone={blockedCount ? "block" : undefined} />
      </div>

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
            overlayNoRowsTemplate="<span class='muted'>No activity yet. Create a mandate and ask the agent for something.</span>"
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
