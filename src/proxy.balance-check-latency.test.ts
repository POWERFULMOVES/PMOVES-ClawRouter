import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import type { BalanceMonitor, SufficiencyResult } from "./balance.js";
import { startProxy, type ProxyHandle } from "./proxy.js";

/**
 * Regression test: the pre-request balance check runs before SSE headers are
 * flushed. On a slow/unresponsive RPC (Solana worst case ≈ 34s of retries),
 * the streaming client hears nothing and times out at ~10-15s — triggering
 * the retry storm the heartbeat mechanism exists to prevent. The check must
 * be time-bounded so first bytes go out promptly.
 */
describe("streaming first-byte latency under slow balance RPC", () => {
  let upstream: Server;
  let proxy: ProxyHandle;
  const RPC_DELAY_MS = 10_000;

  const slowMonitor = {
    checkBalance: async () => {
      await new Promise((r) => setTimeout(r, RPC_DELAY_MS));
      return {
        balance: 10_000_000n,
        balanceUSD: "$10.00",
        isLow: false,
        isEmpty: false,
        walletAddress: "0xslow",
      };
    },
    checkSufficient: async (): Promise<SufficiencyResult> => {
      await new Promise((r) => setTimeout(r, RPC_DELAY_MS));
      return {
        sufficient: true,
        info: {
          balance: 10_000_000n,
          balanceUSD: "$10.00",
          isLow: false,
          isEmpty: false,
          walletAddress: "0xslow",
        },
      };
    },
    deductEstimated: () => {},
    invalidate: () => {},
  } as unknown as BalanceMonitor;

  beforeAll(async () => {
    upstream = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-balance-latency",
          object: "chat.completion",
          model: "openai/gpt-5.5",
          choices: [
            { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
      );
    });

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address() as AddressInfo;

    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: `http://127.0.0.1:${addr.port}`,
      port: 0,
      _balanceMonitorOverride: slowMonitor,
    });
  }, 10_000);

  afterAll(async () => {
    await proxy?.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("emits first bytes well before a slow balance check resolves", async () => {
    const start = Date.now();
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-5.5",
        messages: [{ role: "user", content: "balance latency test" }],
        max_tokens: 16,
        stream: true,
      }),
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    const ttfbMs = Date.now() - start;

    let text = new TextDecoder().decode(first.value);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }

    expect(ttfbMs).toBeLessThan(5_000);
    expect(text).toContain("hi");
  }, 30_000);
});
