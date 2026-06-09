// The reflection model seam. The default `ReflectionProvider` needs to call a
// hosted model, but `@qmilab/asterism-reflect` must NOT import the substrate
// (the adapter-boundary rule: only `adapter-pi` imports Pi). So reflection talks
// to a model through this narrow `ChatModelClient` — one method, system + user in,
// text out — and ships its own dependency-free HTTP implementation over `fetch`.
//
// Keeping the interface this small is deliberate: tests inject a canned client and
// never touch the network, and a host that prefers a different transport can
// supply its own without `reflect` growing a provider SDK dependency.

/** A single chat turn: a system instruction and the user content to reflect on. */
export interface ChatRequest {
  system: string;
  user: string;
}

/**
 * A hosted chat model the reflection provider calls. The contract is just "given
 * a system + user message, return the model's text" — no streaming, no tools, no
 * provider types leak through. Inject a fake in tests.
 */
export interface ChatModelClient {
  complete(request: ChatRequest, signal?: AbortSignal): Promise<string>;
}

/**
 * Config for the built-in HTTP client. Plain data, Pi-free — the host wiring
 * resolves these from the environment (the same env the CLI's `run` uses) and the
 * client maps them onto the provider's wire format.
 */
export interface HttpChatClientConfig {
  /** Provider id, e.g. "openai", "anthropic". */
  provider: string;
  /** Model id, e.g. "gpt-4o-mini", "claude-haiku-4-5". */
  id: string;
  /** Base URL for the provider endpoint (e.g. https://api.openai.com/v1). */
  baseUrl: string;
  /**
   * Provider protocol. "anthropic-messages" selects the Anthropic Messages wire
   * format; anything else (the default) uses OpenAI chat-completions. Kept aligned
   * with the adapter's provider defaults so naming a provider is enough.
   */
  api?: string;
  /** The provider API key — infrastructure, never an agent-scoped credential. */
  apiKey: string;
  /** Max output tokens to request. Default 1024 — proposals are short. */
  maxTokens?: number;
  /** Injectable fetch for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
}

/** Whether a config targets Anthropic's Messages API rather than OpenAI's. */
function isAnthropic(config: HttpChatClientConfig): boolean {
  return config.api === "anthropic-messages" || config.provider === "anthropic";
}

/** Read a nested string off an unknown JSON value without trusting its shape. */
function pick(value: unknown, ...path: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

async function readError(res: Response): Promise<string> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "";
  }
  const snippet = body.length > 200 ? `${body.slice(0, 200)}…` : body;
  return `model request failed (${res.status} ${res.statusText})${snippet ? `: ${snippet}` : ""}`;
}

/** Extract the assistant text from an OpenAI chat-completions response. */
function openaiText(json: unknown): string {
  const content = pick(json, "choices", 0, "message", "content");
  if (typeof content !== "string") {
    throw new Error("unexpected OpenAI response: no choices[0].message.content");
  }
  return content;
}

/** Extract and concatenate the text blocks of an Anthropic Messages response. */
function anthropicText(json: unknown): string {
  const content = pick(json, "content");
  if (!Array.isArray(content)) {
    throw new Error("unexpected Anthropic response: content is not an array");
  }
  const text = content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
  return text;
}

/**
 * Build an HTTP {@link ChatModelClient} for the configured provider. Supports the
 * two wire formats Asterism configures out of the box — OpenAI chat-completions
 * and Anthropic Messages — and uses a deterministic (temperature 0) call so the
 * same transcript reflects consistently. Throws a clear error on a non-2xx
 * response or an unrecognized response shape.
 */
export function createHttpChatClient(
  config: HttpChatClientConfig,
): ChatModelClient {
  const doFetch = config.fetchImpl ?? fetch;
  const maxTokens = config.maxTokens ?? 1024;

  return {
    async complete(request, signal): Promise<string> {
      const anthropic = isAnthropic(config);
      const url = anthropic
        ? `${config.baseUrl}/v1/messages`
        : `${config.baseUrl}/chat/completions`;

      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      const body = anthropic
        ? {
            model: config.id,
            max_tokens: maxTokens,
            temperature: 0,
            system: request.system,
            messages: [{ role: "user", content: request.user }],
          }
        : {
            model: config.id,
            temperature: 0,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
          };
      if (anthropic) {
        headers["x-api-key"] = config.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["authorization"] = `Bearer ${config.apiKey}`;
      }

      const res = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(await readError(res));
      const json: unknown = await res.json();
      return anthropic ? anthropicText(json) : openaiText(json);
    },
  };
}
