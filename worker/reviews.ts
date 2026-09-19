// Review writes shared by the HTTP API and the Telegram evening review.

export interface ReviewInput {
  period: string;
  period_start: string;
  answers: Record<string, string>;
  mood?: number | null;
  energy?: number | null;
  focus?: number | null;
  satisfaction?: number | null;
}

/** Insert or replace the review for (user, period, period_start) — PUT /api/reviews. */
export async function upsertReview(db: D1Database, userId: number, b: ReviewInput): Promise<void> {
  await db.prepare(
    `INSERT INTO reviews (user_id, period, period_start, answers, mood, energy, focus, satisfaction)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, period, period_start) DO UPDATE SET
       answers = excluded.answers, mood = excluded.mood, energy = excluded.energy,
       focus = excluded.focus, satisfaction = excluded.satisfaction`
  ).bind(userId, b.period, b.period_start, JSON.stringify(b.answers ?? {}),
         b.mood ?? null, b.energy ?? null, b.focus ?? null, b.satisfaction ?? null).run();
}

function prevDate(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Consecutive dates ending at `date` (a local YYYY-MM-DD) that have a daily review. */
export async function dailyReviewStreak(db: D1Database, userId: number, date: string): Promise<number> {
  const { results } = await db.prepare(
    "SELECT period_start FROM reviews WHERE user_id = ? AND period = 'daily' AND period_start <= ? ORDER BY period_start DESC LIMIT 400"
  ).bind(userId, date).all<{ period_start: string }>();
  let streak = 0;
  let expect = date;
  for (const r of results) {
    if (r.period_start !== expect) break;
    streak++;
    expect = prevDate(expect);
  }
  return streak;
}
