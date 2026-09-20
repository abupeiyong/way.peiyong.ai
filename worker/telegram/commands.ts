// The command table (PRD §7.2, #20/#21): every `/name args` the bot understands. Deterministic, no model
// calls except /guide. The webhook resolves the user and builds the context; this module only acts.
//   /start        link/login payloads (link.ts, login.ts) or a hello
//   /today        the day: top three with ✓, tasks with ✓, inbox count, carry row
//   /plan         ask for the top three (topthree.ts)
//   /task <text>  micro-syntax in taskparse.ts → a task for today (or the date given)
//   /done         open tasks as ✓ buttons        /inbox   inbox items with [今天] [明天] [🗑]
//   /week         this week's plan (weekly.ts)   /goals   goals.ts        /review [daily|weekly]
//   /note <text>  append to today's reflection   /guide <text>            /find <text>
//   /body         the weight goal's numbers: trend, rate, projected date, verdict (body.ts), with
//                 [📈 图表] into the web Body page and [⚖️ 称重] [🍜 记饭] [🏃 记运动] (bd:<code>)
//   /weight [72.4]  log the day's weight (kg 公斤 斤 lb 磅); with no number, today and the trend (weight.ts)
//   /meal [早|午|晚|加餐] <text>  log a meal by text; with no text, the ask with [跳过] [没吃] (meal.ts)
//   /workout <activity> <minutes> [intensity]  log a workout; with no args, the activity buttons (workout.ts)
//   /timezone /settings /mute /unlink            account.ts
//   /help         this list

import { bodyBlock, bodySummary, suggestedWeightGoal } from "../body.ts";
import { askWeight, weightCommand } from "./weight.ts";
import { updateDay } from "../days.ts";
import { materializeRepeats } from "../tasks.ts";
import { muteCommand, settingsCommand, timezoneCommand, unlinkCommand } from "./account.ts";
import { fmtMin } from "./blocks.ts";
import { cb, shiftDate, type BodyAction, type CallbackContext } from "./callback.ts";
import { logEvent } from "./events.ts";
import { findGoal, goalLine, goalsCommand } from "./goals.ts";
import { guideTurn } from "./guide.ts";
import { loginRequest } from "./login.ts";
import { interruptReview, startReview } from "./review.ts";
import type { Reply, TgMessage } from "./router.ts";
import { parseTaskInput } from "./taskparse.ts";
import { askTopThree } from "./topthree.ts";
import { logCommand, timerStart, timerStop, tracksCommand } from "./stream.ts";
import { weekCommand } from "./weekly.ts";
import { mealCommand } from "./meal.ts";
import { workoutCommand } from "./workout.ts";

export const HELP: Reply = {
  text: [
    "Way · 道 — 命令 · Commands",
    "",
    "/today  今天的三件事和任务 · Today's plan",
    "/plan  定今天的三件事 · Set the top three",
    "/task 明天 打电话给银行 @目标 #30m !must  记一件事 · Add a task",
    "/done  勾掉一件事 · Tick off a task",
    "/inbox  收件箱 · Inbox",
    "/week  本周计划 · This week",
    "/goals  目标进度 · Goals",
    "/body  体重趋势和预计达成日 · Weight trend and projection",
    "/weight 72.4  记体重 · Log your weight",
    "/meal 牛肉面  记一餐 · Log a meal（/meal 午 牛肉面）",
    "/workout 跑步 30  记一次运动 · Log a workout",
    "/review  今日复盘 · Review the day（/review weekly 周复盘）",
    "/note 一句话  记进今天的反思 · Add to today's reflection",
    "/guide 问题  问道引 · Ask the Guide",
    "/tracks  我的追踪 · My trackers",
    "/log 读书 45  记一笔 · Log a value",
    "/timer 读书 … /stop  计时 · Time something（也认 /开始 /停止）",
    "/find 关键词  查找 · Find tasks and goals",
    "/timezone /settings /mute /unlink",
    "",
    "随手发一句话，就收进 Inbox · Anything else you send goes to your inbox.",
  ].join("\n"),
};

const CONNECTED: Reply = {
  text: "已连接 · You're connected.\n随手发一句话，就收进 Inbox · Send me anything and it goes to your inbox.\n/help 看全部命令 · /help for every command",
};

export type CommandContext = CallbackContext;

export async function handleCommand(ctx: CommandContext, name: string, args: string, _message: TgMessage): Promise<void> {
  await logEvent(ctx.db, ctx.userId, "command", "used");
  switch (name) {
    case "start":
      if (await loginRequest(ctx, args)) return;
      await ctx.send(CONNECTED);
      break;
    case "help": await ctx.send(HELP); break;
    case "today": await ctx.send(await todayCard(ctx)); break;
    case "plan": await askTopThree(ctx); break;
    case "task": await taskCommand(ctx, args); break;
    case "add": await taskCommand(ctx, args); break;
    case "done": await ctx.send(await doneCard(ctx)); break;
    case "inbox": await inboxCommand(ctx); break;
    case "week": await weekCommand(ctx); break;
    case "goals": await goalsCommand(ctx); break;
    case "body": await bodyCommand(ctx); break;
    case "weight": await weightCommand(ctx, args); break;
    case "meal": await mealCommand(ctx, args); break;
    case "workout": await workoutCommand(ctx, args); break;
    case "review": await startReview(ctx, /^w/i.test(args) ? "weekly" : "daily"); return; // starts its own state
    case "note": await noteCommand(ctx, args); break;
    case "guide": await guideCommand(ctx, args); break;
    case "find": await findCommand(ctx, args); break;
    case "tracks": case "track": await tracksCommand(ctx); break;
    case "log": await logCommand(ctx, args); break;
    // Not "start": that is Telegram's own deep-link command, handled above.
    case "timer": case "开始": case "计时": await timerStart(ctx, args); break;
    case "stop": case "停止": await timerStop(ctx); break;
    case "timezone": case "tz": await timezoneCommand(ctx, args); return; // may open its own state
    case "settings": await settingsCommand(ctx); break;
    case "mute": await muteCommand(ctx, args); break;
    case "unlink": await unlinkCommand(ctx); break;
    default:
      await ctx.send({ text: `不认识 /${name} · Unknown command. /help 看全部 · /help lists them all.` });
  }
  // Any command pauses a review in progress and offers to continue.
  const paused = await interruptReview(ctx);
  if (paused) await ctx.send(paused);
}

// ---------- /today ----------

interface TaskRow { id: number; title: string; start_min: number | null; end_min: number | null; done: number; estimate_min: number | null }

function shortTitle(t: string, max = 36): string {
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

async function todayCard(ctx: CommandContext): Promise<Reply> {
  const { db, userId, today } = ctx;
  await materializeRepeats(db, userId, today);
  const day = await db.prepare("SELECT top1, top1_done, top2, top2_done, top3, top3_done FROM days WHERE user_id = ? AND date = ?")
    .bind(userId, today).first<Record<string, string | number>>();
  const { results: tasks } = await db.prepare(
    "SELECT id, title, start_min, end_min, done, estimate_min FROM tasks WHERE user_id = ? AND date = ? AND inbox = 0 AND dropped = 0 ORDER BY done, start_min IS NULL, start_min, id"
  ).bind(userId, today).all<TaskRow>();
  const inbox = await db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND inbox = 1 AND done = 0 AND dropped = 0").bind(userId).first<{ n: number }>();
  const carry = await db.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND inbox = 0 AND done = 0 AND dropped = 0 AND date < ? AND repeat = 'never'"
  ).bind(userId, today).first<{ n: number }>();

  const tops = ([1, 2, 3] as const).map((n) => ({ n, text: String(day?.[`top${n}`] ?? "").trim(), done: !!day?.[`top${n}_done`] })).filter((t) => t.text);
  const lines = [`🗓 今天 · Today ${today}`];
  if (tops.length) {
    lines.push("", "🎯 三件事 · Top three", ...tops.map((t) => `${t.done ? "✓" : `${t.n}.`} ${t.text}`));
  } else {
    lines.push("", "🎯 三件事还没定 · No top three yet — /plan");
  }
  if (tasks.length) {
    lines.push("", `📋 任务 · Tasks ${tasks.filter((t) => t.done).length}/${tasks.length}`,
      ...tasks.map((t) => `${t.done ? "✓" : "○"} ${t.start_min !== null ? `${fmtMin(t.start_min)}${t.end_min !== null ? `–${fmtMin(t.end_min)}` : ""}  ` : ""}${t.title}`));
  } else {
    lines.push("", "📋 今天没有任务 · No tasks today — /task 记一件");
  }
  if (inbox?.n) lines.push("", `📥 Inbox 里有 ${inbox.n} 件 · ${inbox.n} in the inbox — /inbox`);
  if (carry?.n) lines.push(`⤴ 有 ${carry.n} 件旧事未完成 · ${carry.n} unfinished from earlier days`);

  const keyboard = [
    ...(tops.some((t) => !t.done) ? [tops.filter((t) => !t.done).map((t) => ({ text: `✓ 三件事 ${t.n}`, callback_data: cb.topDone(t.n, today) }))] : []),
    ...tasks.filter((t) => !t.done).slice(0, 12).map((t) => [{ text: `✓ ${shortTitle(t.title)}`, callback_data: cb.taskDone(t.id) }]),
    ...(carry?.n ? [[
      { text: `⤴ 顺延 ${carry.n}`, callback_data: cb.carry("forward") },
      { text: "放下 Let go", callback_data: cb.carry("drop") },
    ]] : []),
  ];
  return { text: lines.join("\n"), ...(keyboard.length && { reply_markup: { inline_keyboard: keyboard } }) };
}

// ---------- /task ----------

function taskCard(task: { id: number; title: string }, when: string, extras: string[]): Reply {
  return {
    text: `📝 已记到${when} · Added\n${task.title}${extras.length ? `\n${extras.join(" · ")}` : ""}`,
    reply_markup: {
      inline_keyboard: [[
        { text: "✓ 完成", callback_data: cb.taskDone(task.id) },
        { text: "📅 明天", callback_data: cb.taskSchedule(task.id, 1) },
        { text: "🎯 链接目标", callback_data: cb.taskLinkGoal(task.id) },
        { text: "🗑", callback_data: cb.taskDelete(task.id) },
      ]],
    },
  };
}

async function taskCommand(ctx: CommandContext, args: string): Promise<void> {
  if (!args.trim()) {
    await ctx.send({ text: "用法 · Usage: /task 明天 打电话给银行 @目标 #30m !must\n日期、@目标、#时长、!优先级都可选 · date, @goal, #minutes and !priority are all optional" });
    return;
  }
  const p = parseTaskInput(args, ctx.today);
  if (!p.title) {
    await ctx.send({ text: "任务写什么？ · What is the task? 例如 /task 明天 打电话给银行" });
    return;
  }
  const date = p.date ?? ctx.today;
  const goal = p.goalQuery ? await findGoal(ctx.db, ctx.userId, p.goalQuery) : null;
  const row = await ctx.db.prepare(
    "INSERT INTO tasks (user_id, title, date, inbox, priority, estimate_min, goal_id) VALUES (?, ?, ?, 0, ?, ?, ?) RETURNING id, title"
  ).bind(ctx.userId, p.title, date, p.priority ?? "should", p.estimate_min, goal?.id ?? null).first<{ id: number; title: string }>();
  if (!row) throw new Error("task insert failed");
  const when = date === ctx.today ? "今天" : date === shiftDate(ctx.today, 1) ? "明天" : date;
  const extras = [
    ...(p.estimate_min ? [`${p.estimate_min} 分钟`] : []),
    ...(p.priority ? [p.priority] : []),
    ...(goal ? [`🎯 ${goal.title}`] : p.goalQuery ? [`（没找到目标「${p.goalQuery}」· no goal matched）`] : []),
  ];
  await logEvent(ctx.db, ctx.userId, "capture", "used");
  await ctx.send(taskCard(row, when, extras));
}

// ---------- /done ----------

async function doneCard(ctx: CommandContext): Promise<Reply> {
  const { results } = await ctx.db.prepare(
    "SELECT id, title, start_min, end_min, done, estimate_min FROM tasks WHERE user_id = ? AND date = ? AND inbox = 0 AND dropped = 0 AND done = 0 ORDER BY start_min IS NULL, start_min, id"
  ).bind(ctx.userId, ctx.today).all<TaskRow>();
  if (!results.length) return { text: "今天没有未完成的任务 ✓ · Nothing open today" };
  return {
    text: `✓ 点一下完成 · Tap to complete\n${results.map((t) => `○ ${t.title}`).join("\n")}`,
    reply_markup: { inline_keyboard: results.slice(0, 20).map((t) => [{ text: `✓ ${shortTitle(t.title)}`, callback_data: cb.taskDone(t.id) }]) },
  };
}

// ---------- /inbox ----------

async function inboxCommand(ctx: CommandContext): Promise<void> {
  const { results } = await ctx.db.prepare(
    "SELECT id, title FROM tasks WHERE user_id = ? AND inbox = 1 AND done = 0 AND dropped = 0 ORDER BY id DESC LIMIT 10"
  ).bind(ctx.userId).all<{ id: number; title: string }>();
  if (!results.length) {
    await ctx.send({ text: "Inbox 是空的 ✓ · Inbox is empty" });
    return;
  }
  // One card per item so each keeps its own buttons after the others are handled.
  for (const t of results) {
    await ctx.send({
      text: `📥 ${t.title}`,
      reply_markup: {
        inline_keyboard: [[
          { text: "📅 今天", callback_data: cb.taskSchedule(t.id, 0) },
          { text: "📅 明天", callback_data: cb.taskSchedule(t.id, 1) },
          { text: "🎯", callback_data: cb.taskLinkGoal(t.id) },
          { text: "🗑", callback_data: cb.taskDelete(t.id) },
        ]],
      },
    });
  }
}

// ---------- /body ----------

/**
 * The deterministic body block (PRD-body §8.3, §11): verdict, projected date and rate, the same numbers
 * a Guide reply about the goal quotes, under [📈 图表] into the web page that draws them and the three
 * logging buttons. Without a plan, the offer to turn one on and a link to the goal.
 */
async function bodyCommand(ctx: CommandContext): Promise<void> {
  const summary = await bodySummary(ctx.db, ctx.userId, ctx.today);
  if (summary) {
    await ctx.send({
      text: bodyBlock(summary),
      reply_markup: {
        inline_keyboard: [
          [{ text: "📈 图表 · Chart", url: `${ctx.origin}/body` }],
          [
            { text: "⚖️ 称重", callback_data: cb.bodyAction("weigh") },
            { text: "🍜 记饭", callback_data: cb.bodyAction("meal") },
            { text: "🏃 记运动", callback_data: cb.bodyAction("workout") },
          ],
        ],
      },
    });
    return;
  }
  const suggested = await suggestedWeightGoal(ctx.db, ctx.userId);
  await ctx.send({
    text: suggested
      ? `这是体重目标？开启体重追踪 · Track this as a weight goal\n🎯 ${suggested}\n在网页的目标页加上身体计划 · Add a body plan to the goal on the web.`
      : "还没有身体计划 · No body plan yet.\n在网页给体重目标加上身体计划，之后这里就有趋势和预计达成日 · Add one to a weight goal on the web.",
    reply_markup: { inline_keyboard: [[{ text: "🎯 目标 · Goals", url: `${ctx.origin}/goals` }]] },
  });
}

/** `bd:<code>` — the three logging buttons under /body, each opening the ask that already exists. */
export async function bodyAction(ctx: CommandContext, action: BodyAction): Promise<string> {
  if (!(await bodySummary(ctx.db, ctx.userId, ctx.today))) return "没有身体计划 · No body plan";
  if (action === "weigh") {
    await askWeight(ctx);
    return "回复体重就行 · Reply with your weight";
  }
  if (action === "meal") {
    await mealCommand(ctx, "");
    return "记一餐 · Log a meal";
  }
  await workoutCommand(ctx, "");
  return "记一次运动 · Log a workout";
}

// ---------- /note ----------

async function noteCommand(ctx: CommandContext, args: string): Promise<void> {
  const text = args.trim();
  if (!text) {
    await ctx.send({ text: "用法 · Usage: /note 今天学到的一件事" });
    return;
  }
  const day = await ctx.db.prepare("SELECT reflection FROM days WHERE user_id = ? AND date = ?").bind(ctx.userId, ctx.today).first<{ reflection: string }>();
  const reflection = day?.reflection?.trim() ? `${day.reflection.trim()}\n${text}` : text;
  await updateDay(ctx.db, ctx.userId, ctx.today, { reflection });
  await ctx.send({ text: `📓 已记进今天的反思 · Added to today's reflection\n${text}` });
}

// ---------- /guide ----------

async function guideCommand(ctx: CommandContext, args: string): Promise<void> {
  const text = args.trim();
  if (!text) {
    await ctx.send({ text: "问道引什么？ · Ask the Guide anything: /guide 这个季度我该聚焦什么？\n或回复道引的任何一条消息继续对话 · or reply to any Guide message to continue." });
    return;
  }
  await guideTurn(ctx, text);
}

// ---------- /find ----------

async function findCommand(ctx: CommandContext, args: string): Promise<void> {
  const q = args.trim();
  if (!q) {
    await ctx.send({ text: "用法 · Usage: /find 关键词" });
    return;
  }
  const like = `%${q.toLowerCase().replace(/[%_]/g, "")}%`;
  const { results: tasks } = await ctx.db.prepare(
    "SELECT id, title, date, done FROM tasks WHERE user_id = ? AND dropped = 0 AND lower(title) LIKE ? ORDER BY done, date IS NULL, date DESC, id DESC LIMIT 8"
  ).bind(ctx.userId, like).all<{ id: number; title: string; date: string | null; done: number }>();
  const { results: goals } = await ctx.db.prepare(
    `SELECT g.id, g.title, g.level, g.status, g.progress, g.target_date, a.name AS area FROM goals g LEFT JOIN areas a ON a.id = g.area_id
      WHERE g.user_id = ? AND g.status NOT IN ('archived','abandoned') AND lower(g.title) LIKE ? ORDER BY g.status = 'completed', g.id LIMIT 6`
  ).bind(ctx.userId, like).all<{ id: number; title: string; level: "year"; status: string; progress: number; target_date: string | null; area: string | null }>();
  if (!tasks.length && !goals.length) {
    await ctx.send({ text: `没找到「${q}」 · Nothing matched` });
    return;
  }
  const lines = [`🔎 「${q}」`];
  if (tasks.length) lines.push("", "任务 · Tasks", ...tasks.map((t) => `${t.done ? "✓" : "○"} ${t.title}${t.date ? ` · ${t.date}` : " · inbox"}`));
  if (goals.length) lines.push("", "目标 · Goals", ...goals.map((g) => goalLine(g, ctx.today)));
  await ctx.send({
    text: lines.join("\n"),
    reply_markup: {
      inline_keyboard: [
        ...tasks.filter((t) => !t.done).slice(0, 6).map((t) => [{ text: `✓ ${shortTitle(t.title)}`, callback_data: cb.taskDone(t.id) }]),
        ...goals.filter((g) => g.status !== "completed").slice(0, 4).map((g) => [{ text: `🎯 ${shortTitle(g.title)} ${g.progress}%`, callback_data: cb.goal(g.id, "view") }]),
      ],
    },
  });
}
