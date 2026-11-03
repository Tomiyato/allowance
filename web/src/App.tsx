import { lazy, Suspense, useEffect } from "react";
import { isFixture } from "./api";
import { BrandMark, Icon } from "./components/Icon";
import { MandateMeter } from "./components/MandateMeter";
import { AgentPage } from "./pages/AgentPage";
import { MandatePage } from "./pages/MandatePage";
import { Link, usePath } from "./router";
import { useStore } from "./store";

// AG Grid is the heaviest dependency; load it only on the Ledger page.
const LedgerPage = lazy(() => import("./pages/LedgerPage").then((m) => ({ default: m.LedgerPage })));

const NAV = [
  { to: "/mandate", label: "Mandate", match: ["/", "/mandate"] },
  { to: "/agent", label: "Agent", match: ["/agent"] },
  { to: "/ledger", label: "Ledger", match: ["/ledger"] },
];

export function App() {
  const path = usePath().replace(/\/+$/, "") || "/";
  const { refresh } = useStore();

  useEffect(() => {
    void refresh();
  }, [path, refresh]);

  useEffect(() => {
    const page = NAV.find((n) => n.match.includes(path))?.label ?? "Mandate";
    document.title = `${page} · Allowance`;
  }, [path]);

  let page;
  if (path === "/agent") page = <AgentPage />;
  else if (path === "/ledger") page = <LedgerPage />;
  else page = <MandatePage />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/mandate" className="brand" aria-label="Allowance home">
            <BrandMark />
            <span className="brand-name">Allowance</span>
          </Link>
          <nav className="nav" aria-label="Main">
            {NAV.map((n) => (
              <Link key={n.to} to={n.to} className={`nav-link ${n.match.includes(path) ? "active" : ""}`} aria-current={n.match.includes(path) ? "page" : undefined}>
                {n.label}
              </Link>
            ))}
          </nav>
          <MandateMeter />
        </div>
      </header>

      <main className="main">
        <OfflineBanner />
        <Suspense fallback={<div className="page"><div className="skeleton" style={{ height: 320 }} /></div>}>
          <div key={path} className="route">{page}</div>
        </Suspense>
      </main>

      <Footer />
      <Toasts />
    </div>
  );
}

function OfflineBanner() {
  const { state, loadError, refresh } = useStore();
  if (state || !loadError) return null;
  return (
    <div className="page offline-wrap">
      <div className="offline" role="alert">
        <Icon name="alert" size={20} />
        <div>
          <strong>Cannot reach the Allowance server.</strong>
          <span>
            {loadError}. Start the backend, or preview the UI with <a href="?fixture=1">fixture data</a>.
          </span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    </div>
  );
}

function Footer() {
  const { state, loadError } = useStore();
  const mode = state?.mode;
  const payment = mode
    ? mode.payment === "mock"
      ? "Mock rail"
      : `PayPal sandbox (${mode.payment.replace("_", " ")})`
    : "…";
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span className="tagline">Give your AI agent an allowance, not your wallet.</span>
        <span className="mode-badge" aria-label="Integrations in use">
          {isFixture && <span className="tag tag-fixture">FIXTURE DATA</span>}
          {mode?.payment === "mock" && <span className="tag tag-mock">MOCK PAYMENTS</span>}
          {loadError && !state ? (
            <span className="mode-err">
              <Icon name="alert" size={14} /> Backend unreachable: {loadError}
            </span>
          ) : (
            <span>
              Payments: {payment} · Products: {mode ? (mode.products === "channel3" ? "Channel3" : "Demo catalog") : "…"} · AI:{" "}
              {mode ? prettyAi(mode.ai) : "…"}
            </span>
          )}
        </span>
      </div>
    </footer>
  );
}

function prettyAi(ai: string): string {
  const model = ai.includes(":") ? ai.slice(ai.indexOf(":") + 1) : ai;
  if (/gemini|google/i.test(ai)) return `Gemini (${model})`;
  if (/groq/i.test(ai)) return `Groq (${model})`;
  return ai;
}

function Toasts() {
  const { notices, dismiss } = useStore();
  return (
    <div className="toasts" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`toast toast-${n.kind}`} role={n.kind === "error" ? "alert" : "status"}>
          <Icon name={n.kind === "error" ? "alert" : "check"} size={16} />
          <span>{n.text}</span>
          <button className="toast-x" onClick={() => dismiss(n.id)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
