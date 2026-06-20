// World-facts — the agent's own running record of its current situation ("working
// notes"), and the kernel-owned tools the agent maintains them with.
//
// This is the FIRST kernel-owned tool. Every other tool is a HOST-ENVIRONMENT
// capability (`fs.*`, later shell/network): its `execute` is host code touching the
// host's world, wired through the store-free `CliIO.capabilities` seam, and the
// repeated boundary statement "the kernel never constructs a tool" is precisely about
// those. A world-fact tool is a different category — its `execute` must firewall-
// screen, cap, audit, and upsert an `agentId`-scoped STORE row, guarantees that can
// only live where the store + firewall + event log live, which is core. So the kernel
// owns it, and the boundary statement is REFINED, not weakened:
//
//   The kernel never constructs a tool over the HOST'S ENVIRONMENT (files/shell/
//   network — host capabilities). It DOES own the tool over the agent's OWN KERNEL
//   STATE (world-facts), because the firewall/cap/audit guarantees can only be
//   enforced where the store lives.
//
// "Pi never sees raw capability" still holds — the adapter only ever sees `execute`.
// The §6 "kernel re-enforces on untrusted output" discipline lives INSIDE the tool:
// it treats the agent's tool-call args as untrusted output and re-enforces firewall +
// cap (via `store.recordWorldFact`) before persisting, exactly as `enforceRecall`
// re-enforces the recall provider's output.

import type { ToolInvocation, ToolResult } from "./adapter.js";
import type { Capability } from "./trust.js";
import type { AsterismStore } from "./store.js";
import { MemoryFirewallError } from "./firewall.js";
import { WorldFactCapError } from "./repositories/world-facts.js";

/** Exposure keys for the two world-fact capabilities (both non-destructive `write`). */
export const WORLD_FACT_RECORD_KEY = "notes.record";
export const WORLD_FACT_FORGET_KEY = "notes.forget";

/** A tool failure the model can see and react to (never throws across the seam). */
function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

/** Read a string field from a tool's (untrusted, `unknown`) arguments. */
function stringArg(args: unknown, name: string): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

/** A short, content-free summary of firewall findings for a tool error message. */
function findingSummary(err: MemoryFirewallError): string {
  return err.findings.map((f) => `${f.category}:${f.rule}`).join(", ");
}

/**
 * Build the two kernel-owned world-fact capabilities bound to one agent's store
 * scope. Both are `effect: "write"`: side-effecting (they change what frames the next
 * run) but ordinary — they touch only the agent's own scoped rows, reach nothing
 * external, and are reversible. So they flow through the EXISTING destructive-action
 * gate untouched (withheld under `propose`; executed + audited at `notify`/
 * `autonomous`), and the gate is never weakened — a note write/forget is never a back
 * door to a side effect, and the classifier sees a structured-arg `write` tool, never
 * a command string.
 *
 * The kernel injects these on every run (`run.ts`), so they are exposed automatically
 * (the run's exposure set is `capabilities.map(c => c.key)`). The `store` + `agentId`
 * are captured here, on the kernel's side of the boundary; the adapter receives only
 * the resulting `execute`.
 */
export function worldFactCapabilities(store: AsterismStore, agentId: string): Capability[] {
  const recordNote: Capability = {
    key: WORLD_FACT_RECORD_KEY,
    effect: "write",
    tool: {
      name: "record_note",
      description:
        "Record or update one of your working notes about the current situation — a " +
        "(subject, value) pair you maintain across runs (e.g. subject 'deploy version', " +
        "value 'v0.2.1'). Re-recording the same subject REPLACES its value. These are " +
        "your OWN working notes, not verified facts.",
      inputSchema: {
        type: "object",
        properties: {
          subject: {
            type: "string",
            description: "What the note is about (the key; re-using it supersedes the prior value).",
          },
          value: { type: "string", description: "The current value for that subject." },
        },
        required: ["subject", "value"],
      },
      execute: (invocation: ToolInvocation): ToolResult => {
        const subject = stringArg(invocation.args, "subject");
        const value = stringArg(invocation.args, "value");
        if (subject === undefined || subject.trim() === "") {
          return failure("record_note needs a non-empty 'subject'.");
        }
        // Reject an empty / whitespace-only value too, so the agent's tool and the
        // operator's `notes set` agree (the CLI rejects empty values): a blank note
        // conveys nothing and would just consume a cap slot and frame an empty line.
        if (value === undefined || value.trim() === "") {
          return failure("record_note needs a non-empty 'value'.");
        }
        try {
          const fact = store.recordWorldFact(agentId, subject, value);
          return { output: `Noted '${fact.subject}'.` };
        } catch (err) {
          if (err instanceof MemoryFirewallError) {
            return failure(`That note can't be saved — it trips the safety screen (${findingSummary(err)}).`);
          }
          if (err instanceof WorldFactCapError) {
            return failure(
              `Your working notes are full (${err.cap} max). Remove one with forget_note ` +
                `(or ask an operator to clear one) before recording a new subject.`,
            );
          }
          return failure("Could not save the note.");
        }
      },
    },
  };

  const forgetNote: Capability = {
    key: WORLD_FACT_FORGET_KEY,
    effect: "write",
    tool: {
      name: "forget_note",
      description:
        "Remove one of your working notes by its subject — e.g. a fact that no longer " +
        "holds. Does nothing if you have no note under that subject.",
      inputSchema: {
        type: "object",
        properties: {
          subject: { type: "string", description: "The subject of the working note to remove." },
        },
        required: ["subject"],
      },
      execute: (invocation: ToolInvocation): ToolResult => {
        const subject = stringArg(invocation.args, "subject");
        if (subject === undefined || subject.trim() === "") {
          return failure("forget_note needs a non-empty 'subject'.");
        }
        // Guard the store call the same way record_note does, so an unexpected error
        // (e.g. a transaction/DB fault in clearWorldFact) becomes a model-visible tool
        // failure rather than throwing across the adapter seam — the invariant this
        // module's header states.
        try {
          const removed = store.clearWorldFact(agentId, subject);
          return {
            output: removed ? `Forgot '${subject}'.` : `No working note named '${subject}'.`,
          };
        } catch {
          return failure("Could not clear the note.");
        }
      },
    },
  };

  return [recordNote, forgetNote];
}
