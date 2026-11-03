import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { SearchProductsOutput } from "../../shared/types";
import { fixtureProducts } from "./fixtures";

/** Plays a canned agent turn (tool call with an in-progress state, then text) for ?fixture=1. */
export class FixtureChatTransport implements ChatTransport<UIMessage> {
  async sendMessages({ messages, abortSignal }: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0]) {
    const last = messages[messages.length - 1];
    const prompt = last?.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim() || "something nice";
    const id = Math.random().toString(36).slice(2, 8);
    const output: SearchProductsOutput = { query: prompt, source: "catalog", products: fixtureProducts.slice(0, 3) };
    const reply =
      "Fixture mode: here is what a search looks like. With the backend running, I would compare these, check your mandate and buy the best fit.";

    const script: Array<[number, UIMessageChunk]> = [
      [0, { type: "start" }],
      [0, { type: "start-step" }],
      [150, { type: "tool-input-start", toolCallId: `fx_${id}`, toolName: "search_products" }],
      [100, { type: "tool-input-available", toolCallId: `fx_${id}`, toolName: "search_products", input: { query: prompt } }],
      [1400, { type: "tool-output-available", toolCallId: `fx_${id}`, output }],
      [0, { type: "finish-step" }],
      [0, { type: "start-step" }],
      [200, { type: "text-start", id: `t_${id}` }],
      ...reply.split(/(?<= )/).map((w): [number, UIMessageChunk] => [35, { type: "text-delta", id: `t_${id}`, delta: w }]),
      [0, { type: "text-end", id: `t_${id}` }],
      [0, { type: "finish-step" }],
      [0, { type: "finish" }],
    ];

    let i = 0;
    return new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        if (abortSignal?.aborted || i >= script.length) {
          controller.close();
          return;
        }
        const [wait, chunk] = script[i++];
        if (wait) await new Promise((r) => setTimeout(r, wait));
        controller.enqueue(chunk);
      },
    });
  }

  async reconnectToStream() {
    return null;
  }
}
