import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";

/**
 * Regression test: upstream partner APIs may gzip their responses. Node's
 * fetch transparently decompresses the body but keeps the original
 * content-length header (the compressed size). Forwarding that header with
 * the decompressed bytes truncates/corrupts the client response.
 */
describe("partner proxy with gzipped upstream", () => {
  let upstream: Server;
  let proxy: ProxyHandle;

  // Repetitive payload so gzip output is much smaller than the original
  const payload = {
    results: Array.from({ length: 50 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/result/${i}`,
      summary: "The same summary text repeated to make compression effective.",
    })),
  };

  beforeAll(async () => {
    upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on("end", () => {
        const compressed = gzipSync(JSON.stringify(payload));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "Content-Length": String(compressed.length),
        });
        res.end(compressed);
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

  it("delivers the full decompressed body to the client", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/exa/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "compression test" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(payload);
  });
});
