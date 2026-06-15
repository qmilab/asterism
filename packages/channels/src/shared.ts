// Cross-transport channel utilities — the pieces a chat transport needs whatever
// app it speaks to, lifted here so Telegram and Discord share one copy instead of
// each growing its own. Deliberately small: a running-channel handle, the minimal
// `fetch` shape a REST transport uses, message chunking, and an abortable delay.

/** A running channel: how it identifies itself, and how to stop it gracefully. */
export interface ChannelHandle {
  /** The bot's `@username`/handle, resolved at startup (absent if the API gave none). */
  botUsername?: string;
  /**
   * Stop listening and let the loop unwind. Aborts the in-flight connection and
   * resolves once the loop has exited — so a caller can await it before tearing
   * down the store the dispatcher still depends on (the `serve()` contract).
   */
  stop: () => Promise<void>;
}

/**
 * The minimal `fetch` shape a REST transport uses — satisfied by the global
 * `fetch`. `body` is optional so a GET (no body) and a POST share the one type.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Resolve after `ms`, or immediately if the signal aborts first. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Split text into pieces no longer than `max`, preferring to break at a newline so
 * a chunk boundary lands between lines rather than mid-word. A run with no newline
 * in range is hard-split at the limit. Empty pieces are dropped (chat APIs reject
 * an empty message).
 */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const newline = rest.lastIndexOf("\n", max);
    const cut = newline > 0 ? newline : max;
    const piece = rest.slice(0, cut);
    if (piece.length > 0) chunks.push(piece);
    // Drop a single boundary newline so it isn't re-emitted at the next chunk's head.
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
