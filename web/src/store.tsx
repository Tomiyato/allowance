import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppState, ProposePurchaseOutput } from "../../shared/types";
import { api, isFixture } from "./api";
import { fixtureMessages } from "./fixtures";
import { FixtureChatTransport } from "./fixtureTransport";
import { errorText } from "./format";

interface Notice {
  id: number;
  kind: "error" | "ok";
  text: string;
}

/** A red-team simulation result shown in the chat view. Kept out of the model's chat history on purpose:
 *  the real agent never made this call. */
export interface Simulation {
  id: number;
  /** Number of chat messages when it ran: it renders after that many messages. */
  at: number;
  output: ProposePurchaseOutput;
}

interface Store {
  state: AppState | null;
  loadError: string | null;
  refresh: () => Promise<void>;
  /** Runs an action, then refreshes state; shows errors as a toast. Returns undefined on failure. */
  run: <T>(fn: () => Promise<T>, okText?: string) => Promise<T | undefined>;
  notices: Notice[];
  dismiss: (id: number) => void;
  chat: Chat<UIMessage>;
  simulations: Simulation[];
  addSimulation: (at: number, output: ProposePurchaseOutput) => void;
}

const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const s = use(StoreContext);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [simulations, setSimulations] = useState<Simulation[]>([]);
  const seq = useRef(0);

  const notify = useCallback((kind: Notice["kind"], text: string) => {
    const id = ++seq.current;
    setNotices((n) => [...n.slice(-2), { id, kind, text }]);
    window.setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await api.state();
      setState(s);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, []);

  // refresh is stable (no deps), so the Chat can hold it.
  // One Chat instance for the whole app, so the conversation survives page switches.
  const [chat] = useState(
    () =>
      new Chat<UIMessage>({
        id: "allowance-agent",
        messages: isFixture ? fixtureMessages : [],
        transport: isFixture ? new FixtureChatTransport() : new DefaultChatTransport({ api: "/api/chat" }),
        onFinish: () => void refresh(),
        onError: () => void refresh(),
      }),
  );

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, okText?: string) => {
      try {
        const out = await fn();
        if (okText) notify("ok", okText);
        return out;
      } catch (e) {
        notify("error", errorText(e));
        return undefined;
      } finally {
        await refresh();
      }
    },
    [notify, refresh],
  );

  // The first load happens in App (it refreshes on every route change).
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const dismiss = useCallback((id: number) => setNotices((n) => n.filter((x) => x.id !== id)), []);

  const addSimulation = useCallback((at: number, output: ProposePurchaseOutput) => {
    const id = ++seq.current;
    setSimulations((xs) => [...xs, { id, at, output }]);
  }, []);

  const value = useMemo(
    () => ({ state, loadError, refresh, run, notices, dismiss, chat, simulations, addSimulation }),
    [state, loadError, refresh, run, notices, dismiss, chat, simulations, addSimulation],
  );
  return <StoreContext value={value}>{children}</StoreContext>;
}
