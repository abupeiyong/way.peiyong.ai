# Way · 道

个人人生规划系统：方向 → 年/季/周目标 → 每日三件事 + 时间块 → 复盘。

**正式环境**: https://way.peiyong.ai（worker `way`，D1 `way-preview-db`，2026-09-09 起为本仓库代码）
- 旧版（另一台机器的代码）已被接管；其数据库 `way-db` 原样保留作备份，数据已迁移进新库（见 `backup/`，不入库）。
- 预览 worker `way-preview` 与正式环境共用同一个 D1，确认不用后建议删除：`wrangler delete --name way-preview`

## 栈

- 前端: Vite + React 18（无路由库，`src/api.ts` 里 30 行 pushState 路由），单文件设计系统 `src/styles.css`
- UI: 画·书 (huashu) design — 与 english.peiyong.ai 同源（token 来自 `../english.peiyong.ai/public/styles.css`）：
  宣纸底纹 #f4eddc、朱砂印 #a8332a、楷体标题+EB Garamond 斜体英文副标、Ma Shan Zheng 品牌字、
  不规则圆角印章(logo/勾选框)、卡片右上角印泥点、格线稿纸 textarea(.ruled)
- 后端: Hono on Cloudflare Workers（`worker/index.ts`），PBKDF2 密码 + D1 cookie session
- 数据: D1（`migrations/0001_init.sql`），单库 9 张表
- AI (Way Guide): 有 `OPENAI_API_KEY` secret 时走 OpenAI 兼容接口（模型 `OPENAI_CHAT_MODEL`），
  否则退回 Workers AI llama-3.3-70b。模型只输出 ```proposals``` JSON 提案，用户点 Approve 才写库。

## 命令

```sh
npm run dev                # localhost:5174（wrangler.dev.jsonc,无 AI 绑定）
npm run db:migrate:local   # 本地 D1 迁移(加 -c wrangler.dev.jsonc)
npm run typecheck
npm run deploy             # vite build && wrangler deploy -c dist/way_preview/wrangler.json
npm run db:migrate:remote
npx wrangler secret put OPENAI_API_KEY --name way   # 可选,升级 Guide 模型
```

## 功能清单（与旧版对齐）

- Today: 日期导航、daily intention、Top three、任务(快捷+Detailed 弹窗)、Inbox、
  goal progress、时间块 Schedule(拖动/边缘缩放/双击新建/当前时间线)、daily reflection(4 维打分)、
  跨天未完成任务 carry-forward banner(Bring forward / Let them go)、重复任务(daily/weekly)按天物化
- Timeline: week(weekly plan + 7 天列) / month / quarter / year(按 life area 分组目标)
- Goals: Direction(Refine)、9 个 life areas(色点+满意度)、目标 CRUD 全字段
  (level/type/status/area/parent/priority/日期/进度/信心/成功标准/动机)、按 area 过滤
- Projects: 关联目标、任务进度百分比、展开任务列表、finished 归档
- Reviews: daily/weekly/monthly/quarterly/yearly 各自问题集 + 周期统计 + 4 维评分 + 历史记录
- Insights: 聚焦时长/记录时长/活跃天数/改期次数、每周完成率、按 life area 时间分布、
  心情能量趋势、计划 vs 实际、目标进度
- Guide: 上下文注入(方向/areas/目标/今日/周计划)对话，quick actions,目标分解按钮,
  proposals 审批(create_goal / create_task / set_top_three)
- Settings: 资料、时区、Direction、life areas 编辑(颜色/满意度/归档/新增)、Telegram 连接与各提醒时间、
  安全(关闭密码登录)、退出登录
- Telegram（共享 bot，`docs/PRD-telegram.md`）: 网页扫码/深链绑定；Login Widget / 6 位验证码 / 深链确认三种登录；
  每天晨报+三件事一条消息、21:30 复盘状态机、周一周计划、周日周复盘、中午提醒、时间块提醒、月初领域打分；
  /today /plan /task(明天 … @目标 #30m !must) /done /inbox /week /goals /review /note /guide /find /timezone /settings /mute /unlink；
  随手发消息进 Inbox（转发保留来源、语音 whisper 转写、inline 模式）；道引对话与提案一键采用；纯 Telegram 注册；
  投递/回复率统计（Settings 卡片）

