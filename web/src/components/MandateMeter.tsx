import type { MandateStatus } from "../../../shared/types";
import { money } from "../format";
import { Link } from "../router";
import { useStore } from "../store";

const statusLabel: Record<MandateStatus, string> = {
  draft: "Draft",
  pending_paypal: "Awaiting PayPal",
  active: "Active",
  revoked: "Revoked",
  expired: "Expired",
  exhausted: "Used up",
};

export function StatusPill({ status }: { status: MandateStatus }) {
  return (
    <span className={`pill pill-${status}`}>
      <span className="pill-dot" aria-hidden />
      {statusLabel[status]}
    </span>
  );
}

export function MandateMeter() {
  const { state } = useStore();
  const m = state?.mandate ?? null;

  if (!state) {
    return <div className="meter meter-loading" aria-busy="true" />;
  }
  if (!m) {
    return (
      <Link to="/mandate" className="meter meter-empty" title="Create a mandate">
        <span className="meter-label">No mandate</span>
        <span className="meter-sub">Agent cannot spend</span>
      </Link>
    );
  }

  const remaining = state.remaining;
  const pct = m.budget_total > 0 ? Math.max(0, Math.min(1, remaining / m.budget_total)) : 0;
  const live = m.status === "active";

  return (
    <Link
      to="/mandate"
      className={`meter ${live ? "" : "meter-inactive"}`}
      aria-label={`Mandate ${statusLabel[m.status]}: ${money(remaining)} left of ${money(m.budget_total)}`}
    >
      <div className="meter-top">
        <span className="meter-amount">
          <strong>{money(remaining)}</strong>
          <span className="meter-of"> / {money(m.budget_total)}</span>
        </span>
        <StatusPill status={m.status} />
      </div>
      <div className="meter-track" aria-hidden>
        <div className="meter-fill" style={{ width: `${pct * 100}%` }} />
      </div>
    </Link>
  );
}
