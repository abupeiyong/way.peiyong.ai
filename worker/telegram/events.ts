// Delivery and engagement events (PRD §14, #29): one row per send, reply, failure or use, so the
// questions the PRD leaves open — is the morning message too long? which prompt gets ignored? — are
// answered with numbers. Logging never throws: a failed insert is a console line, not a lost reply.
//
// Schema (migration 0003): telegram_events(user_id, kind, event, local_date, latency_s, created_at).
//   kind   → a scheduled kind (morning, review_prompt, weekly_plan, weekly_review, midday_nudge,
//            area_checkin, block, and the body kinds of PRD-body §6: weigh_in, meal_*, workout_check,
//            body_nudge, body_recap) or a surface (capture, command, guide, inline, voice, photo, mute, unlink).
//            `photo` also doubles as the daily counter behind the ten meal-photo analyses of PRD-body §12.
//   event  → sent | replied | blocked | rate_limited | error | used

import type { TelegramStats } from "../../shared/types.ts";

export type EventName = "sent" | "replied" | "blocked" | "rate_limited" | "error" | "used";

export async function logEvent(
  db: D1Database, userId: number, kind: string, event: EventName,
  extra: { local_date?: string; latency_s?: number } = {},
): Promise<void> {
  try {
    await db.prepare("INSERT INTO telegram_events (user_id, kind, event, local_date, latency_s) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, kind, event, extra.local_date ?? null, extra.latency_s ?? null).run();
  } catch (e) {
    console.error("telegram events: insert failed", e);
  }
}

/**
 * The user answered a scheduled prompt: log `replied` once per (kind, local date), with the seconds since
 * the outbox row says it was sent. A second answer to the same prompt is not a second reply.
 */
export async function logReply(db: D1Database, userId: number, kind: string, localDate: string): Promise<void> {
  try {
    const already = await db.prepare(
      "SELECT 1 FROM telegram_events WHERE user_id = ? AND kind = ? AND event = 'replied' AND local_date = ? LIMIT 1"
    ).bind(userId, kind, localDate).first();
    if (already) return;
    const sent = await db.prepare(
      "SELECT CAST((julianday('now') - julianday(sent_at)) * 86400 AS INTEGER) AS latency FROM telegram_outbox_log WHERE user_id = ? AND kind = ? AND local_date = ?"
    ).bind(userId, kind, localDate).first<{ latency: number }>();
    await logEvent(db, userId, kind, "replied", { local_date: localDate, latency_s: sent?.latency ?? undefined });
  } catch (e) {
    console.error("telegram events: reply log failed", e);
  }
}

/** This user's numbers over the last `days` days (GET /api/telegram/stats). */
export async function telegramStats(db: D1Database, userId: number, today: string, days = 28): Promise<TelegramStats> {
  const since = `datetime('now', '-${days} days')`;
  const from = new Date(today + "T00:00:00Z");
  from.setUTCDate(from.getUTCDate() - (days - 1));
  const fromDate = from.toISOString().slice(0, 10);

  const { results: perKind } = await db.prepare(
    `SELECT kind,
            SUM(CASE WHEN event = 'sent' THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN event = 'replied' THEN 1 ELSE 0 END) AS replied
       FROM telegram_events WHERE user_id = ? AND created_at >= ${since}
        AND kind IN ('morning','review_prompt','weekly_plan','weekly_review','midday_nudge','area_checkin','block',
                     'weigh_in','meal_breakfast','meal_lunch','meal_dinner','workout_check','body_nudge','body_recap')
      GROUP BY kind ORDER BY kind`
  ).bind(userId).all<{ kind: string; sent: number; replied: number }>();

  const counts = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM telegram_events WHERE user_id = ?1 AND created_at >= ${since} AND kind IN ('capture','voice','inline') AND event = 'used') AS captured,
       (SELECT COUNT(*) FROM tasks WHERE user_id = ?1 AND inbox = 1 AND created_at >= ${since}) AS inbox_total,
       (SELECT COUNT(*) FROM telegram_events WHERE user_id = ?1 AND created_at >= ${since} AND event = 'blocked') AS blocked,
       (SELECT COUNT(*) FROM telegram_events WHERE user_id = ?1 AND created_at >= ${since} AND event = 'rate_limited') AS rate_limited,
       (SELECT COUNT(*) FROM telegram_events WHERE user_id = ?1 AND created_at >= ${since} AND event = 'error') AS errors,
       (SELECT COUNT(*) FROM days d WHERE d.user_id = ?1 AND d.date >= ?2 AND d.top1 != ''
          AND EXISTS (SELECT 1 FROM reviews r WHERE r.user_id = ?1 AND r.period = 'daily' AND r.period_start = d.date)) AS loop_days`
  ).bind(userId, fromDate).first<{ captured: number; inbox_total: number; blocked: number; rate_limited: number; errors: number; loop_days: number }>();

  return {
    days,
    kinds: perKind.map((k) => ({
      kind: k.kind, sent: k.sent, replied: k.replied,
      reply_rate: k.sent ? Math.round((k.replied / k.sent) * 100) / 100 : null,
    })),
    loop_days: counts?.loop_days ?? 0,
    captured: counts?.captured ?? 0,
    web_captured: Math.max(0, (counts?.inbox_total ?? 0) - (counts?.captured ?? 0)),
    blocked: counts?.blocked ?? 0,
    rate_limited: counts?.rate_limited ?? 0,
    errors: counts?.errors ?? 0,
  };
}
