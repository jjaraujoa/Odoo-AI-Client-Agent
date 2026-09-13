import { AppError } from "./errors.js";
import { inTransaction } from "./db.js";
import { randomUUID } from "node:crypto";

export async function getLimits(db, identity) {
  const result = await db.query(
    `SELECT *
       FROM agent.agent_limits
      WHERE client_id = $1 AND (linked_user_id = $2 OR linked_user_id IS NULL)
      ORDER BY linked_user_id NULLS LAST
      LIMIT 1`,
    [identity.client_id, identity.id],
  );
  if (!result.rows[0]) throw new AppError(500, "limits_missing", "No existen límites configurados para el cliente.");
  return result.rows[0];
}

export async function consumeRateLimit(db, identity, limits) {
  await inTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`rate:${identity.id}`]);
    const result = await client.query(
      `SELECT
          count(*) FILTER (WHERE created_at >= now() - interval '1 minute')::int AS minute_count,
          count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS day_count
         FROM agent.rate_events
        WHERE linked_user_id = $1 AND created_at >= now() - interval '1 day'`,
      [identity.id],
    );
    const counts = result.rows[0];
    if (counts.minute_count >= limits.requests_per_minute) {
      throw new AppError(429, "minute_limit", "Alcanzaste el límite de solicitudes por minuto.");
    }
    if (counts.day_count >= limits.requests_per_day) {
      throw new AppError(429, "daily_limit", "Alcanzaste el límite diario de solicitudes.");
    }
    await client.query(
      "INSERT INTO agent.rate_events(client_id, linked_user_id) VALUES ($1, $2)",
      [identity.client_id, identity.id],
    );
  });
}

export async function acquireConcurrency(db, identity, limits) {
  const requestId = randomUUID();
  await inTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`concurrency:${identity.id}`]);
    await client.query(
      "DELETE FROM agent.active_requests WHERE linked_user_id = $1 AND lease_expires_at <= now()",
      [identity.id],
    );
    const count = await client.query(
      "SELECT count(*)::int AS total FROM agent.active_requests WHERE linked_user_id = $1",
      [identity.id],
    );
    if (count.rows[0].total >= limits.concurrent_requests) {
      throw new AppError(429, "concurrency_limit", "Ya tienes el máximo de solicitudes simultáneas.");
    }
    await client.query(
      `INSERT INTO agent.active_requests
        (request_id, client_id, linked_user_id, lease_expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [requestId, identity.client_id, identity.id, Number(limits.request_timeout_seconds) + 15],
    );
  });
  return requestId;
}

export async function releaseConcurrency(db, requestId) {
  if (requestId) await db.query("DELETE FROM agent.active_requests WHERE request_id = $1", [requestId]);
}
