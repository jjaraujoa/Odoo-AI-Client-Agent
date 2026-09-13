export async function getOrCreateSession(db, identity, chatId, limits) {
  const inactivity = Number(limits.inactivity_minutes);
  const absoluteHours = Number(limits.absolute_session_hours);
  const result = await db.query(
    `INSERT INTO agent.chat_sessions
        (client_id, linked_user_id, telegram_chat_id, expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4), now() + make_interval(hours => $5))
     ON CONFLICT (client_id, linked_user_id, telegram_chat_id)
     DO UPDATE SET
        last_activity_at = now(),
        expires_at = CASE
          WHEN agent.chat_sessions.cleared_at IS NOT NULL
            OR agent.chat_sessions.expires_at <= now()
            OR agent.chat_sessions.absolute_expires_at <= now()
          THEN now() + make_interval(mins => $4)
          ELSE now() + make_interval(mins => $4)
        END,
        absolute_expires_at = CASE
          WHEN agent.chat_sessions.cleared_at IS NOT NULL
            OR agent.chat_sessions.absolute_expires_at <= now()
          THEN now() + make_interval(hours => $5)
          ELSE agent.chat_sessions.absolute_expires_at
        END,
        cleared_at = NULL,
        state = CASE
          WHEN agent.chat_sessions.expires_at <= now()
            OR agent.chat_sessions.absolute_expires_at <= now()
          THEN '{}'::jsonb
          ELSE agent.chat_sessions.state
        END
     RETURNING *`,
    [identity.client_id, identity.id, chatId, inactivity, absoluteHours],
  );
  return result.rows[0];
}

export async function getRecentMemory(db, session, maxMessages) {
  const result = await db.query(
    `SELECT role, kind, content, created_at
       FROM agent.memory_entries
      WHERE session_id = $1 AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT $2`,
    [session.id, maxMessages],
  );
  return result.rows.reverse();
}

export async function addMemory(db, identity, session, role, kind, content) {
  await db.query(
    `INSERT INTO agent.memory_entries
      (client_id, session_id, linked_user_id, telegram_chat_id, role, kind, content, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
       LEAST($8::timestamptz, $9::timestamptz))`,
    [
      identity.client_id, session.id, identity.id, session.telegram_chat_id,
      role, kind, JSON.stringify(content), session.expires_at, session.absolute_expires_at,
    ],
  );
}

export async function clearSession(db, sessionId) {
  await db.query("DELETE FROM agent.memory_entries WHERE session_id = $1", [sessionId]);
  await db.query(
    `UPDATE agent.chat_sessions
        SET state = '{}'::jsonb, model_mode = 'auto', selected_model_id = NULL,
            cleared_at = now()
      WHERE id = $1`,
    [sessionId],
  );
}
