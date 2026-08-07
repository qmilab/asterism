import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver.js";
import type { Exchange, ExchangeKind } from "../types.js";
import { EXCHANGE_KINDS, validateEnum } from "../types.js";
import { requireAgentId } from "./scope.js";

/**
 * Public input for recording one boundary-crossing artifact. `present` mirrors the
 * manifest's `exists` bit; `runId` is the callee's run — the identity of the exchange
 * instance the reference came from.
 */
export interface RecordExchangeInput {
  connectionId: string;
  fromAgentId: string;
  toAgentId: string;
  kind: ExchangeKind;
  ref: string;
  present: boolean;
  /** The artifact's size when it crossed, when the observation established one. */
  sizeBytes?: number;
  /** True when the redaction boundary changed the path, so `ref` is a display reference. */
  redacted: boolean;
  runId: string;
}

function mapExchange(row: SqlRow): Exchange {
  return {
    id: String(row.id),
    connectionId: String(row.connection_id),
    fromAgentId: String(row.from_agent_id),
    toAgentId: String(row.to_agent_id),
    kind: String(row.kind) as ExchangeKind,
    ref: String(row.ref),
    present: Number(row.present) === 1,
    ...(row.size_bytes === null || row.size_bytes === undefined
      ? {}
      : { sizeBytes: Number(row.size_bytes) }),
    redacted: Number(row.redacted) === 1,
    runId: String(row.run_id),
    createdAt: String(row.created_at),
  };
}

/**
 * The exchanges store — the record of what actually crossed a connection, kept as
 * RESOLVABLE references.
 *
 * Its reason to exist is the resolve, not the audit: `artifact fetch` asks this repository
 * whether a given reference was genuinely produced by a given callee over a given
 * connection, and refuses when it was not. That check is the difference between
 * dereferencing a manifest the caller already holds and handing the caller a cross-agent
 * file-read primitive, so the lookup is deliberately narrow — an EXACT match on a reference
 * within ONE connection, never a scan, a prefix, or a pattern.
 *
 * Scoping follows {@link ConnectionRepository} rather than the single-`agent_id` pattern: a
 * crossing belongs to a PAIR, so rows carry both ids and every method asserts the
 * participants it is called for. There is no method that reads an exchange without naming an
 * agent that took part in it.
 */
export class ExchangeRepository {
  constructor(private readonly driver: SqlDriver) {}

  /**
   * Record one crossed artifact reference. Asserts BOTH participant ids and validates the
   * kind through the same enum chokepoint the rest of the kernel uses, so a kind nothing
   * resolves can never be persisted.
   *
   * Append-only: a re-observation of the same path in a LATER exchange writes a new row
   * rather than updating the old one, so the history of what crossed stays intact and
   * {@link findLatest} resolves by recency. There is no update and no delete — a mistake in
   * what crossed is not something a later write should be able to erase.
   */
  record(input: RecordExchangeInput): Exchange {
    requireAgentId(input.fromAgentId);
    requireAgentId(input.toAgentId);
    validateEnum(input.kind, EXCHANGE_KINDS, "exchange kind");
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO exchanges
           (id, connection_id, from_agent_id, to_agent_id, kind, ref, present, size_bytes,
            redacted, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get([
        id,
        input.connectionId,
        input.fromAgentId,
        input.toAgentId,
        input.kind,
        input.ref,
        input.present ? 1 : 0,
        input.sizeBytes ?? null,
        input.redacted ? 1 : 0,
        input.runId,
        createdAt,
      ]);
    if (!row) throw new Error("exchange insert did not persist");
    return mapExchange(row);
  }

  /**
   * The MOST RECENT crossing of `ref` over `connectionId`, or undefined when that reference
   * never crossed this connection. This is the authorization read behind `artifact fetch`.
   *
   * Four properties make it safe to build a filesystem read on top of:
   *
   *   1. **Exact match, never a search.** `ref = ?` — no prefix, no glob, no `LIKE`. A
   *      reference the caller was never handed simply misses, and a miss is
   *      indistinguishable from an unknown one, so the caller learns nothing it did not
   *      already know from the manifest it received.
   *   2. **Scoped to ONE connection.** The connection the caller holds is passed in, so an
   *      artifact that crossed a DIFFERENT channel (another callee, the other direction, or
   *      a connection since revoked and replaced) never resolves here.
   *   3. **The participant is asserted.** `from_agent_id = ?` pins the row to the agent
   *      doing the fetching; a connection id alone is not enough.
   *   4. **Recency wins.** A path re-crossed in a later exchange resolves to its LATEST
   *      record, which is what makes a deletion (`present = 0`) able to withdraw an earlier
   *      reference rather than being outvoted by history.
   */
  findLatest(
    connectionId: string,
    fromAgentId: string,
    kind: ExchangeKind,
    ref: string,
  ): Exchange | undefined {
    requireAgentId(fromAgentId);
    validateEnum(kind, EXCHANGE_KINDS, "exchange kind");
    const row = this.driver
      .prepare(
        `SELECT * FROM exchanges
           WHERE connection_id = ? AND from_agent_id = ? AND kind = ? AND ref = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT 1`,
      )
      .get([connectionId, fromAgentId, kind, ref]);
    return row ? mapExchange(row) : undefined;
  }

  /**
   * Every crossing `agentId` participated in — as the caller OR the callee — oldest-first.
   * Scoped by the `from_agent_id = ? OR to_agent_id = ?` predicate, so a crossing between
   * two OTHER agents can never appear here. Mirrors `ConnectionRepository.listForAgent`,
   * and uses the same stable `created_at` then `rowid` total order every other list uses.
   */
  listForAgent(agentId: string): Exchange[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(
        `SELECT * FROM exchanges
           WHERE from_agent_id = ? OR to_agent_id = ?
           ORDER BY created_at ASC, rowid ASC`,
      )
      .all([agentId, agentId])
      .map(mapExchange);
  }
}
