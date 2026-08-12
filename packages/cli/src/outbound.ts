// The host side of a bound outbound endpoint — the one place this CLI speaks HTTP on an
// agent's behalf, carrying one of that agent's credentials.
//
// `core` owns the whole decision (which binding, whether the gate allows it, which secret,
// what may come back); this only moves the bytes, the same split `artifactFetchHost`
// makes for the filesystem. Everything here is an obligation `OutboundHost` states, and
// each one is a way the kernel's guarantee fails silently if it is skipped.

import type { OutboundHost, OutboundRequest, OutboundResponse } from "@qmilab/asterism-core";

/**
 * Read at most `maxBytes` of a response body as UTF-8, without buffering more than that.
 *
 * `response.text()` would read the whole body first and only then let anyone bound it,
 * which is exactly the failure the cap exists to prevent — a hostile or merely broken
 * endpoint answering with a gigabyte. Streaming and stopping at the cap keeps the memory
 * ceiling real. A body that arrives without a readable stream (an empty response) reads
 * as the empty string.
 */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (remaining <= 0) break;
      // Keep only what fits. A partial chunk is fine: the kernel truncates again after
      // scrubbing, so this cut is never the one a credential could straddle.
      chunks.push(value.length > remaining ? value.subarray(0, remaining) : value);
      total += Math.min(value.length, remaining);
      if (total >= maxBytes) break;
    }
  } finally {
    // Release the connection whether we finished the body or stopped early at the cap.
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}

/**
 * The shipped {@link OutboundHost}: one `fetch`, with every obligation the seam states.
 *
 *   - **`redirect: "manual"`.** The load-bearing one. Following a redirect would forward
 *     the `Authorization` header to whatever origin the response named — turning an
 *     operator-declared URL into an attacker-chosen one, which is the only way this
 *     capability's central promise ("the credential goes where the operator said") can
 *     break without anyone doing anything wrong. A 3xx is reported as the response it is.
 *   - **A timeout**, via `AbortSignal.timeout`, so a hung socket cannot park a run with
 *     no gate decision to resume from.
 *   - **A bounded read**, so the memory ceiling holds regardless of what the far side
 *     sends.
 *   - **No logging.** Nothing here writes the request, the headers, or the URL anywhere:
 *     the headers carry the credential, and a debug line is a durable leak. The kernel
 *     records what should be recorded, references only.
 *
 * A failure is REPORTED, never thrown: the kernel turns `{ok: false}` into a screened tool
 * error, and screening the reason matters because a network error message can quote the
 * request it failed on.
 */
export function outboundHost(fetchImpl: typeof fetch = fetch): OutboundHost {
  return {
    async call(request: OutboundRequest): Promise<OutboundResponse> {
      try {
        const response = await fetchImpl(request.url, {
          method: "GET",
          headers: { ...request.headers },
          redirect: "manual",
          signal: AbortSignal.timeout(request.timeoutMs),
        });
        return {
          ok: true,
          status: response.status,
          body: await readBounded(response, request.maxBytes),
        };
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          return { ok: false, reason: `no response within ${request.timeoutMs}ms` };
        }
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
