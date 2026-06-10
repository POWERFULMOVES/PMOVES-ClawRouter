import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";

/**
 * Regression test: when a client disconnects while the proxy is polling a
 * slow image job (202 + poll_url flow), the proxy must stop polling.
 * Continuing to poll settles the x402 payment on the first `completed`
 * response — charging the user for a result nobody will receive.
 */
describe("image generation poll loop on client abort", () => {
  let upstream: Server;
  let proxy: ProxyHandle;
  let pollCount = 0;

  beforeAll(async () => {
    upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/v1/images/generations") {
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "job-abort-test",
              poll_url: "/v1/images/generations/job-abort-test",
              status: "queued",
            }),
          );
          return;
        }
        if (req.method === "GET" && req.url === "/v1/images/generations/job-abort-test") {
          pollCount++;
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "job-abort-test", status: "in_progress" }));
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unexpected path" }));
      });
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

  it("stops polling upstream after the client disconnects", async () => {
    pollCount = 0;

    const url = new URL(`${proxy.baseUrl}/v1/images/generations`);
    const body = JSON.stringify({ model: "openai/gpt-image-2", prompt: "a slow image" });

    await new Promise<void>((resolve) => {
      const clientReq = request({
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(body.length) },
      });
      clientReq.on("error", () => resolve());
      clientReq.on("close", () => resolve());
      clientReq.end(body);
      // Abort during the proxy's 2s poll-warmup window, before the first poll
      setTimeout(() => clientReq.destroy(), 1_000);
    });

    // First poll would fire at ~2s, then every 3s. Wait long enough that a
    // non-aborting proxy would have polled at least twice.
    await new Promise((r) => setTimeout(r, 5_500));

    expect(pollCount).toBe(0);
  }, 15_000);
});
