import pg from "pg";

const { Pool } = pg;

export function createDb(connectionString) {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "odoo-ai-agent-control-api",
  });
  pool.on("error", (error) => {
    process.stderr.write(`PostgreSQL pool error: ${error.message}\n`);
  });
  return pool;
}

export async function inTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

