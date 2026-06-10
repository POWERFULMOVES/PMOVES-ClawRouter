import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { startProxy, type ProxyHandle } from "./proxy.js";

/**
 * Regression test: a client aborting mid-upload on the media endpoints
 * (/v1/images/generations etc.) rejects the request-body async iterator.
 * The rejection must be contained by the server — an escaped rejection
 * from the paymentStore.run() callback is an unhandledRejection, which
 * kills the whole proxy process under Node's default semantics.
 */
describe("aborted media upload", () => {
  let proxy: ProxyHandle;

  beforeAll(async () => {
    proxy = await startProxy({
      wallet: generatePrivateKey(),
      apiBase: "http://127.0.0.1:9", // never reached — abort happens during body read
      port: 0,
      skipBalanceCheck: true,
    });
  }, 10_000);

  afterAll(async () => {
    await proxy?.close();
  });

  it("does not emit an unhandledRejection when the client aborts mid-body", async () => {
    const captured: unknown[] = [];
    const previous = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    const capture = (reason: unknown) => {
      captured.push(reason);
    };
    process.on("unhandledRejection", capture);

    try {
      const url = new URL(`${proxy.baseUrl}/v1/images/generations`);
      await new Promise<void>((resolve) => {
        const clientReq = request({
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Declare more bytes than we send so the server keeps reading
            "content-length": "100000",
          },
        });
        clientReq.on("error", () => resolve());
        clientReq.on("close", () => resolve());
        // Send a partial body, then sever the connection mid-read
        clientReq.write('{"model":"openai/gpt-image-2","prompt":"');
        setTimeout(() => clientReq.destroy(), 50);
      });

      // Give the server's rejected iterator a tick to surface
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      process.removeListener("unhandledRejection", capture);
      for (const listener of previous) {
        process.on("unhandledRejection", listener);
      }
    }

    expect(captured).toEqual([]);
  });
});
