import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlRow } from "../db/driver.js";
import type { BoundEndpoint } from "../types.js";
import { requireAgentId } from "./scope.js";

export interface CreateEndpointInput {
  /** The operator's handle — already validated by {@link validateEndpointName}. */
  name: string;
  /** The complete `https` URL — already validated by {@link validateEndpointUrl}. */
  url: string;
  /** Which of the agent's own credentials the call carries, by key. */
  credentialKey: string;
}

function mapEndpoint(row: SqlRow): BoundEndpoint {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    name: String(row.name),
    url: String(row.url),
    credentialKey: String(row.credential_key),
    createdAt: String(row.created_at),
  };
}

/**
 * The agent-scoped store of bound outbound endpoints — the rows that grant an agent a
 * credential-bearing capability.
 *
 * Every method asserts an `agentId` like every other scoped repository, and that single
 * fact carries the isolation guarantee for this whole class: a binding belongs to one
 * agent, so the capability it grants can only ever appear in that agent's run, and the
 * credential it names is resolved from that agent's own credential rows. There is no
 * query path here that can see across agents.
 */
export class EndpointRepository {
  constructor(private readonly driver: SqlDriver) {}

  /**
   * Bind an endpoint, or REBIND an existing name in place — re-adding a name replaces its
   * URL and credential rather than throwing on `UNIQUE(agent_id, name)`, matching how
   * `secrets add` rotates a key. The id and `created_at` are preserved, so the binding
   * keeps its identity and the capability key never changes underneath a run.
   */
  create(agentId: string, input: CreateEndpointInput): BoundEndpoint {
    requireAgentId(agentId);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const row = this.driver
      .prepare(
        `INSERT INTO agent_endpoints (id, agent_id, name, url, credential_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, name)
           DO UPDATE SET url = excluded.url, credential_key = excluded.credential_key
         RETURNING *`,
      )
      .get([id, agentId, input.name, input.url, input.credentialKey, createdAt]);
    if (!row) throw new Error("endpoint insert did not persist");
    return mapEndpoint(row);
  }

  getByName(agentId: string, name: string): BoundEndpoint | undefined {
    requireAgentId(agentId);
    const row = this.driver
      .prepare(`SELECT * FROM agent_endpoints WHERE name = ? AND agent_id = ?`)
      .get([name, agentId]);
    return row ? mapEndpoint(row) : undefined;
  }

  list(agentId: string): BoundEndpoint[] {
    requireAgentId(agentId);
    return this.driver
      .prepare(`SELECT * FROM agent_endpoints WHERE agent_id = ? ORDER BY name ASC`)
      .all([agentId])
      .map(mapEndpoint);
  }

  /** Remove a binding by name. Returns true if a row was deleted. */
  deleteByName(agentId: string, name: string): boolean {
    requireAgentId(agentId);
    const existed = this.getByName(agentId, name) !== undefined;
    this.driver
      .prepare(`DELETE FROM agent_endpoints WHERE name = ? AND agent_id = ?`)
      .run([name, agentId]);
    return existed;
  }
}
