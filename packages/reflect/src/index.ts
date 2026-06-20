// @qmilab/asterism-reflect — the default ReflectionProvider.
//
// Takes a run transcript, calls a hosted model via API, and returns PROPOSED typed
// memory writes with confidence. Pure TypeScript — no Python, no local ML, no
// embeddings in Phase 0. This is the one package permitted to import a reflection
// model client; it never persists memory (that is the reviewer's decision, gated
// by the human and the kernel's memory firewall).

export {
  DefaultReflectionProvider,
  buildReflectionUserPrompt,
  parseProposals,
  REFLECTION_SYSTEM_PROMPT,
  buildObjectiveReflectionUserPrompt,
  parseObjectiveProposals,
  OBJECTIVE_REFLECTION_SYSTEM_PROMPT,
} from "./provider.js";

export { createHttpChatClient } from "./model.js";
export type {
  ChatModelClient,
  ChatRequest,
  HttpChatClientConfig,
} from "./model.js";
