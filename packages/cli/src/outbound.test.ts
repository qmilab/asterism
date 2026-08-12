// The shipped `OutboundHost` — the one place this binary carries an agent's credential
// to another machine.
//
// Everything here is one of the seam's stated obligations, and each is checked against a
// REAL server on loopback rather than by inspecting the `RequestInit` object. The
// difference matters most for the redirect rule: asserting `redirect: "manual"` was
// passed proves the argument was written, not that a 302 goes unfollowed — and it is the
// second thing that keeps a credential from reaching an origin the operator never named.

import { afterEach, expect, test } from "bun:test";

import { outboundHost } from "./outbound.js";

const servers: { stop: () => void }[] = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop();
});

/** Start a loopback server with a handler, returning its base URL. */
function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push({ stop: () => server.stop(true) });
  return `http://127.0.0.1:${server.port}`;
}

const host = outboundHost();
const req = (url: string, over: Record<string, unknown> = {}) => ({
  url,
  headers: { Authorization: "Bearer tok-secret-value" },
  timeoutMs: 5_000,
  maxBytes: 1_000_000,
  ...over,
});

test("a redirect is REPORTED, never followed — the credential does not reach the new origin", async () => {
  let secondHopSawAuth: string | null = "not-called";
  const elsewhere = serve((request) => {
    secondHopSawAuth = request.headers.get("authorization");
    return new Response("you got the token", { status: 200 });
  });
  const base = serve(() => new Response(null, { status: 302, headers: { location: elsewhere } }));

  const response = await host.call(req(base));

  // The 3xx comes back as the response it is…
  expect(response).toMatchObject({ ok: true, status: 302 });
  // …and the redirect target was never contacted at all, so it never saw the header.
  expect(secondHopSawAuth).toBe("not-called");
});

test("the credential is sent to the declared origin", async () => {
  // The paired positive: without it, the test above passes for a host that sends nothing.
  let seen: string | null = null;
  const base = serve((request) => {
    seen = request.headers.get("authorization");
    return new Response("ok");
  });

  const response = await host.call(req(base));

  expect(seen).toBe("Bearer tok-secret-value");
  expect(response).toMatchObject({ ok: true, status: 200, body: "ok" });
});

test("the body read stops at maxBytes rather than buffering the whole response", async () => {
  const base = serve(() => new Response("y".repeat(500_000)));

  const response = await host.call(req(base, { maxBytes: 64 }));

  expect(response.ok).toBe(true);
  expect(response.ok && response.body).toBe("y".repeat(64));
});

test("a slow endpoint times out and is reported, not thrown", async () => {
  const base = serve(
    () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("late")), 2_000)),
  );

  const response = await host.call(req(base, { timeoutMs: 50 }));

  expect(response).toEqual({ ok: false, reason: "no response within 50ms" });
});

test("an unreachable endpoint is reported, not thrown", async () => {
  // Port 1 on loopback: nothing is listening, and the connection is refused promptly.
  const response = await host.call(req("http://127.0.0.1:1/nope"));

  expect(response.ok).toBe(false);
});

test("an empty body reads as the empty string rather than failing", async () => {
  const base = serve(() => new Response(null, { status: 204 }));

  const response = await host.call(req(base));

  expect(response).toMatchObject({ ok: true, status: 204, body: "" });
});

test("a GET is what goes out — the class ships no other method", async () => {
  let method: string | null = null;
  const base = serve((request) => {
    method = request.method;
    return new Response("ok");
  });

  await host.call(req(base));

  expect(method).toBe("GET");
});
