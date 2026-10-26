# CHANGELOG

## v0.1.0 — 2026-10-26

首个可跑版本。目标不是「功能多」，是**讲清楚 + 可验证**。

### 包含

| 代号 | 交付物 | 内容 |
|---|---|---|
| **P1** | 核心库 | `src/` 9 个内核文件（manifest 契约 / router / inject / buffer / store / checkup / indexer / constants / schema）+ `bootstrap.js` + `adapter/{dsh,standalone}.js` + 示例清单 8 条与 7 篇中性语料 |
| **P2** | 判据工具链 | `scripts/route-probe.mjs`（红线 4/4 · 改写 ≥8/10 · 泄漏 0）· `keys-clean.mjs`（碎片键）· `trace-stats.mjs`（趋势）· `skill-doctor.mjs`（技能池）· `gate.mjs`（发布门） |
| **P3** | 方法论文档 | `README.md`（含「它不做什么」）· `docs/WHY.md` · `docs/FALSE-GREEN.md` · `docs/FAILURES.md` · `docs/BOUNDARY.md` · `docs/ARCH.md`（架构图） |

附带：`checks/` 三条运维检查（`bom` / `manifest-checkup` / `handover-lag`），统一 `{id, level, detail}` JSON 契约，可被 CI 消费。

### 判据（首发 Gate 五条，全过）

| # | 判据 | 实测 |
|---|---|---|
| 1 | 干净目录 clone → 10 分钟内出结果 | clone + demo + probe = **0.91 秒** |
| 2 | 私人词 / 绝对路径 0 命中 | `gate.mjs`：39 文件 / 3 私人词 / **0 命中** |
| 3 | README 有「它不做什么」 | 有 |
| 4 | 至少一条可复跑判据且有阈值 | `route-probe.mjs`：红线 4/4 · 改写 ≥8/10 · 泄漏 0，退出码 0/1 |
| 5 | LICENSE + README + 架构图 | MIT · README · `docs/ARCH.md` |

### 快照时点

内核快照取于 **2026-10-26**（运行线 `_raw/`，复制前后源哈希 0 变化）。
此后运行线的内核改动**不自动同步**到本仓库 —— 需要时手动 cherry-pick（双线单向规则见 `docs/BOUNDARY.md`）。

### 已知限制

- 关键词路线有召回天花板；触顶判定方法见 `docs/FALSE-GREEN.md` → 「触顶判定」
- 只提供两个 adapter（DSH / standalone）；其它宿主需按四方法契约自行实现
- 示例清单 8 条只是形状示范，不是「最佳实践清单」
- `checks/bom.mjs` 只覆盖 PowerShell 系；其它语言的编码检查未做

### 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-26 | 首版：三圈边界、四刀解耦、四把尺子、三条 checks、五篇方法论文档 |
