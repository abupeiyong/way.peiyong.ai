// Monthly life-area check-in (PRD §6 row 7, #32): on the 1st, one message listing the areas with their
// current satisfaction. Tapping an area swaps the keyboard for 1–10 (ac:<area>:<n>), which writes
// areas.satisfaction — the same column the web Settings page edits — and returns to the list.
// Everything happens by editing the one message; [完成] freezes it.

import { cb, type CallbackContext } from "./callback.ts";
import { logEvent } from "./events.ts";
import type { Reply } from "./router.ts";

interface AreaRow { id: number; name: string; satisfaction: number | null }

async function areasOf(ctx: Pick<CallbackContext, "db" | "userId">): Promise<AreaRow[]> {
  const { results } = await ctx.db.prepare("SELECT id, name, satisfaction FROM areas WHERE user_id = ? AND archived = 0 ORDER BY sort, id")
    .bind(ctx.userId).all<AreaRow>();
  return results;
}

function listCard(areas: AreaRow[], month: string): Reply {
  return {
    text: [
      `🌱 ${month} 人生领域 · Life areas — 这个月各方面感觉如何？ How is each area (1–10)?`,
      "",
      ...areas.map((a) => `${a.name} · ${a.satisfaction ?? "—"}`),
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [
        ...chunk(areas.map((a) => ({ text: `${a.name}${a.satisfaction ? ` ${a.satisfaction}` : ""}`, callback_data: cb.checkinPick(a.id) })), 3),
        [{ text: "完成 Done", callback_data: cb.checkinDone() }],
      ],
    },
  };
}

function rateCard(area: AreaRow, month: string): Reply {
  const row = (from: number) => Array.from({ length: 5 }, (_, i) => from + i).map((n) => ({
    text: area.satisfaction === n ? `【${n}】` : String(n), callback_data: cb.checkinRate(area.id, n),
  }));
  return {
    text: `🌱 ${month} · ${area.name}\n现在 ${area.satisfaction ?? "—"}/10，给它打几分？ · Rate it 1–10`,
    reply_markup: { inline_keyboard: [row(1), row(6), [{ text: "← 返回", callback_data: cb.checkinList() }]] },
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type CheckinContext = Pick<CallbackContext, "db" | "userId" | "today" | "send">;

/** The 1st-of-the-month message. */
export async function sendCheckin(ctx: CheckinContext): Promise<void> {
  const areas = await areasOf(ctx);
  if (!areas.length) return;
  await ctx.send(listCard(areas, ctx.today.slice(0, 7)));
}

export async function checkinList(ctx: CallbackContext): Promise<string> {
  await ctx.edit(listCard(await areasOf(ctx), ctx.today.slice(0, 7)));
  return "";
}

export async function checkinPick(ctx: CallbackContext, areaId: number): Promise<string> {
  const area = (await areasOf(ctx)).find((a) => a.id === areaId);
  if (!area) return "找不到这个领域 · Area not found";
  await ctx.edit(rateCard(area, ctx.today.slice(0, 7)));
  return "";
}

/** ac:<area>:<n> — absolute, so a replay writes the same value. */
export async function checkinRate(ctx: CallbackContext, areaId: number, n: number): Promise<string> {
  const r = await ctx.db.prepare("UPDATE areas SET satisfaction = ? WHERE id = ? AND user_id = ?").bind(n, areaId, ctx.userId).run();
  if (!r.meta.changes) return "找不到这个领域 · Area not found";
  await logEvent(ctx.db, ctx.userId, "area_checkin", "replied", { local_date: ctx.today });
  await ctx.edit(listCard(await areasOf(ctx), ctx.today.slice(0, 7)));
  return `${n}/10`;
}

export async function checkinDone(ctx: CallbackContext): Promise<string> {
  const areas = await areasOf(ctx);
  await ctx.finish([`🌱 ${ctx.today.slice(0, 7)} 人生领域 · Life areas ✓`, "", ...areas.map((a) => `${a.name} · ${a.satisfaction ?? "—"}`)].join("\n"));
  return "已记录 · Saved";
}
