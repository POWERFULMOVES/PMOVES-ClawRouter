import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";

/**
 * Regression test: a streaming retry that deduplicates onto an in-flight
 * original must receive SSE headers + heartbeats while it waits. Waiting
 * silently recreates the client-timeout/retry storm the heartbeat mechanism
 * exists to prevent (OpenClaw aborts after ~10-15s of silence).
 */
describe("streaming dedup waiter", () => {
  let upstream: Server;
  let proxy: ProxyHandle;
  const UPSTREAM_DELAY_MS = 3_500;

  beforeAll(async () => {
    upstream = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      // Slow upstream: longer than one heartbeat interval (2s)
      await new Promise((r) => setTimeout(r, UPSTREAM_DELAY_MS));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-dedup-test",
          object: "chat.completion",
          model: "openai/gpt-5.5",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "slow but steady" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
      );
    });

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address() as AddressInfo;

    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: `http://127.0.0.1:${addr.port}`,
      port: 0,
      skipBalanceCheck: true,
    });
  }, 10_000);

  afterAll(async () => {
    await proxy?.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("sends first bytes to the waiter before the original completes", async () => {
    const body = JSON.stringify({
      model: "openai/gpt-5.5",
      messages: [{ role: "user", content: "dedup waiter heartbeat test" }],
      max_tokens: 32,
      stream: true,
    });
    const post = () =>
      fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

    // Original request
    const originalPromise = post();

    // Retry arrives while the original is still in flight
    await new Promise((r) => setTimeout(r, 150));
    const retryStart = Date.now();
    const retryRes = await post();
    const reader = retryRes.body!.getReader();
    const firstChunk = await reader.read();
    const ttfbMs = Date.now() - retryStart;

    // Drain the rest of the retry stream
    let retryText = new TextDecoder().decode(firstChunk.value);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      retryText += new TextDecoder().decode(value);
    }

    const originalRes = await originalPromise;
    const originalText = await originalRes.text();

    // The waiter must hear something well before the original finishes
    expect(ttfbMs).toBeLessThan(2_500);
    // And still receive the real completion when it lands
    expect(retryText).toContain("slow but steady");
    expect(originalText).toContain("slow but steady");
  }, 15_000);
});
