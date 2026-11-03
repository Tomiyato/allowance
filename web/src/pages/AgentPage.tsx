import { useChat } from "@ai-sdk/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  GetMandateOutput,
  ListPurchasesOutput,
  ProposePurchaseOutput,
  ReportSuspiciousOutput,
  RequestRefundOutput,
  SearchProductsOutput,
} from "../../../shared/types";
import { api } from "../api";
import { Markdown } from "../components/Markdown";
import {
  FlaggedCard,
  GenericToolCard,
  MandateCheckCard,
  ProductStrip,
  PurchaseCard,
  PurchasesListCard,
  RefundCard,
  ToolError,
  ToolPending,
} from "../components/cards";
import { Icon } from "../components/Icon";
import { money } from "../format";
import { Link } from "../router";
import { useStore, type Simulation } from "../store";

const SUGGESTIONS = [
  "Find a gardening gift for my mom around $40",
  "Order a robot vacuum",
  "What have I spent so far?",
  "Return the last purchase",
];

type Part = UIMessage["parts"][number];

/** A non-2xx /api/chat response surfaces as the raw body; unwrap the server's { error } JSON. */
function chatErrorText(msg: string): string {
  try {
    const j = JSON.parse(msg) as { error?: unknown };
    if (j && typeof j.error === "string") return j.error;
  } catch {
    /* not JSON */
  }
  return msg || "The agent did not answer.";
}

function ToolPart({ part }: { part: Part }) {
  if (!isToolUIPart(part)) return null;
  const name = getToolName(part);
  const p = part;

  if (p.state === "output-error") return <ToolError name={name} text={p.errorText || "unknown error"} />;
  if (p.state === "output-denied") return <ToolError name={name} text="denied" />;
  if (p.state !== "output-available") return <ToolPending name={name} />;

  const output = p.output as unknown;
  if (output == null) return <GenericToolCard name={name} output={output} />;
  switch (name) {
    case "search_products":
      return <ProductStrip output={output as SearchProductsOutput} />;
    case "propose_purchase": {
      const o = output as ProposePurchaseOutput;
      return o.purchase ? <PurchaseCard purchase={o.purchase} /> : <GenericToolCard name={name} output={output} />;
    }
    case "request_refund": {
      const o = output as RequestRefundOutput;
      return o.purchase ? <RefundCard output={o} /> : <GenericToolCard name={name} output={output} />;
    }
    case "get_mandate":
      return <MandateCheckCard output={output as GetMandateOutput} />;
    case "list_purchases":
      return <PurchasesListCard output={output as ListPurchasesOutput} />;
    case "report_suspicious_content": {
      const o = output as ReportSuspiciousOutput;
      return o.flagged ? <FlaggedCard output={o} /> : <GenericToolCard name={name} output={output} />;
    }
    default:
      return <GenericToolCard name={name} output={output} />;
  }
}

function Message({ m }: { m: UIMessage }) {
  if (m.role === "user") {
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="msg msg-user">
        <div className="bubble">{text}</div>
      </div>
    );
  }
  return (
    <div className="msg msg-agent">
      <span className="avatar" aria-hidden>
        <Icon name="bot" size={18} />
      </span>
      <div className="msg-parts">
        {m.parts.map((part, i) => {
          if (part.type === "text") {
            return part.text.trim() ? <Markdown key={i} text={part.text} /> : null;
          }
          if (part.type === "step-start" || part.type === "reasoning") return null;
          return <ToolPart key={isToolUIPart(part) ? part.toolCallId : i} part={part} />;
        })}
      </div>
    </div>
  );
}

/** A red-team simulation result: the blocked card a prompt-injected agent would have produced. */
function SimulatedAttempt({ sim, capNote }: { sim: Simulation; capNote: string }) {
  const p = sim.output.purchase;
  return (
    <div className="msg msg-agent msg-sim" id={`sim-${sim.id}`}>
      <span className="avatar avatar-sim" aria-hidden>
        <Icon name="bot" size={18} />
      </span>
      <div className="msg-parts">
        <div className="sim-banner">
          <span className="sim-tag">Red-team simulation</span>
          <strong>Simulation: this is what a prompt-injected agent tried to do</strong>
          <span>
            It obeyed the poisoned listing and tried to buy {p.items[0]?.qty ?? 5} units. The call took the same path as any
            real agent purchase, and the policy engine{p.status === "blocked" ? " stopped it in code" : " decided it in code"}.
            {capNote}
          </span>
        </div>
        <PurchaseCard purchase={p} />
      </div>
    </div>
  );
}

function SafetyDemo({ onRun, busy, disabled }: { onRun: () => void; busy: boolean; disabled: boolean }) {
  return (
    <aside className="safety-demo" aria-label="Safety demo">
      <Icon name="shield" size={18} />
      <p>
        <span className="safety-label">Safety demo</span>
        <span className="safety-line">The model can be fooled. The mandate can't.</span>
      </p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onRun} disabled={disabled || busy}>
        {busy ? <span className="spinner" /> : <Icon name="shieldX" size={15} />}
        Simulate a hijacked agent
      </button>
    </aside>
  );
}

export function AgentPage() {
  const { chat, state, run, simulations, addSimulation } = useStore();
  const [simBusy, setSimBusy] = useState(false);
  const { messages, sendMessage, regenerate, status, error, stop, clearError } = useChat({ chat });
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";
  const m = state?.mandate ?? null;
  const canSpend = m?.status === "active";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, status, simulations.length]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    if (error) clearError();
    void sendMessage({ text: t });
    setInput("");
  };

  const simulate = async () => {
    setSimBusy(true);
    const out = await run(() => api.simulateHijack());
    if (out?.purchase) addSimulation(messages.length, out);
    setSimBusy(false);
  };

  // Simulations render after the number of chat messages that existed when they ran.
  const simsAt = (i: number) => simulations.filter((x) => Math.min(x.at, messages.length) === i);
  const capNote =
    state?.mode.payment === "authorization" && m
      ? ` Behind that, PayPal's ${money(m.budget_total)} authorization hold caps what can ever be captured.`
      : "";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(input);
  };

  const last = messages[messages.length - 1];
  const waitingForFirstToken = status === "submitted" || (status === "streaming" && last?.role === "user");

  return (
    <div className="page page-chat">
      <header className="page-head compact">
        <p className="eyebrow">Step 2 · Agent</p>
        <h1>Your shopping agent</h1>
      </header>

      <SafetyDemo onRun={() => void simulate()} busy={simBusy} disabled={busy || !state} />

      {state && !canSpend && (
        <div className="no-mandate fade-in" role="status">
          <Icon name="shield" size={22} />
          <div>
            <strong>{m ? `The mandate is ${m.status.replace("_", " ")}.` : "No active mandate."}</strong>
            <span>
              {m?.status === "revoked"
                ? "The agent has no spending power. It can still search, but any purchase will be refused."
                : "The agent can search, but it cannot buy anything until you approve a mandate."}
            </span>
          </div>
          <Link to="/mandate" className="btn btn-primary btn-sm">
            {m && (m.status === "draft" || m.status === "pending_paypal") ? "Finish mandate" : "Create a mandate"}
          </Link>
        </div>
      )}

      <div className="chat" aria-live="polite">
        {messages.length === 0 && simulations.length === 0 && (
          <div className="chat-empty">
            <Icon name="bot" size={28} />
            <p>
              Ask for an errand. The agent shops on its own inside your mandate
              {canSpend && m ? ` (${money(state?.remaining ?? 0)} left)` : ""} and asks you when a rule says so.
            </p>
          </div>
        )}
        {messages.map((msg, i) => (
          <Fragment key={msg.id}>
            {simsAt(i).map((x) => (
              <SimulatedAttempt key={`sim-${x.id}`} sim={x} capNote={capNote} />
            ))}
            <Message m={msg} />
          </Fragment>
        ))}
        {simsAt(messages.length).map((x) => (
          <SimulatedAttempt key={`sim-${x.id}`} sim={x} capNote={capNote} />
        ))}
        {waitingForFirstToken && (
          <div className="msg msg-agent">
            <span className="avatar" aria-hidden>
              <Icon name="bot" size={18} />
            </span>
            <div className="typing" aria-label="Agent is thinking">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
        {error && (
          <div className="chat-error" role="alert">
            <Icon name="alert" size={16} />
            <span>
              {/429|rate.?limit/i.test(error.message)
                ? "The AI is rate-limited right now. Wait a minute and try again."
                : chatErrorText(error.message)}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={clearError}>
              Dismiss
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                clearError();
                void regenerate();
              }}
            >
              Try again
            </button>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="composer-wrap">
        <div className="suggestions" aria-label="Suggested requests">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="chip chip-suggest" onClick={() => send(s)} disabled={busy}>
              {s}
            </button>
          ))}
        </div>
        <form className="composer" onSubmit={onSubmit}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask the agent to find, buy or return something…"
            aria-label="Message the agent"
          />
          {busy ? (
            <button type="button" className="btn btn-ghost" onClick={() => void stop()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-primary btn-icon" disabled={!input.trim()} aria-label="Send">
              <Icon name="send" size={18} />
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
