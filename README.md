# ctx-manifest

**这不是一个 agent 框架，是「上下文装配」的一个零件。**

你把 system prompt 拆成一份清单：每条写清「内容在哪、什么时候该注入、最多占多少预算」。
它负责按预算注入、留证据、体检、以及在你改坏时告诉你改坏了哪。

```bash
git clone https://github.com/soniamariart6543-bot/ctx-manifest.git && cd ctx-manifest
node examples/mini/demo.mjs "改文件之前要做什么"
node scripts/route-probe.mjs
```

第一条命令会打印「命中了哪几个单元、为什么命中、实际注入了多少字符」。
第二条是回归集：改清单之后跑它，能立刻知道召回掉了没有。

---

## 它解决什么问题

system prompt 长到几千字之后，会同时坏在三件事上，而你往往不知道是哪件：

| 症状 | 真实原因 | 本项目的对应 |
|---|---|---|
| 改了一句话，别的地方变差 | 没有回归集，改动无法比较 | `scripts/route-probe.mjs`（红线句 + 改写召回 + 泄漏） |
| 注入总字符数说不清 | 没有预算，谁都能往里加 | manifest 里的 `budget` / `budgets` / `limits` |
| 「这段到底进没进去」查不到 | 没有 trace | 每轮写一行 trace（命中单元 / 字符 / 裁剪 / 悬空） |
| 文件路径改了，注入静默失效 | 没有悬空检查 | `checkup` 的「悬空引用」 |
| 同一个词挂了两个条目，互相抢 | 没有冲突仲裁 | `buffer` 的同 key 仲裁（胜者注入，败者留痕） |

## 核心概念只有四个

1. **单元（unit）**：一条可独立调用的上下文条目。字段：`id / path / layer / mode / keys / weight / budget`。
2. **层（layer）**：`L1` 恒注（每轮都注入，如身份与输出契约）· `L2` 条件（命中关键词才给一行指针）·
   `L3` 长尾（命中才给「标题 + 路径 + 摘要」）· `anchor` 锚层（会话交接这类固定指针）。
3. **模式（mode）**：`excerpt` 注入正文（按预算截断）· `pointer` 只给一行指针 · `lookup` 只给摘要 + 路径。
4. **预算（budget）**：每条一个上限，每层一个上限，总量一个上限。超了先裁，裁了要留痕。

一句话：**用「路径 + 摘要」替代「全量预加载」**，需要细节时再读文件。

## 十分钟上手

```bash
# 1) 跑一下 demo，看看注入长什么样
node examples/mini/demo.mjs

# 2) 换成你自己的话试试
node examples/mini/demo.mjs "上次说到哪儿了"

# 3) 改示例清单里的 keys，再跑回归集，看召回变化
node scripts/route-probe.mjs
```

看到 `结论：PASS` 就说明清单在这个回归集上是达标的。
改你的清单时用它当门槛：**红线句必须 4/4，改写召回 ≥8/10，闲聊泄漏 0。**

## 它不做什么

- **不是框架**：不提供 agent 循环、不调度工具、不管多轮对话状态。它只算「这一段该不该进上下文」。
- **不做向量检索**：关键词 + 同义表，可解释、可 diff、零依赖。召回有天花板 —— 触顶就记录，不硬修。
- **不做自动记忆写入**：清单改动必须人审。自动抽取只是候选，落盘要签字（见 `docs/FALSE-GREEN.md`）。
- **不托管你的数据**：没有任何网络请求，不下载模型，不读环境变量里的密钥。
- **不承诺跨宿主全兼容**：只给两个 adapter（DSH / standalone）。换宿主＝照着契约再写一个文件。
- **不追求召回 100%**：关键词路线有天花板；到顶就把数字记下来，而不是加词加到不可维护。

## 目录结构

```
src/                内核：manifest 契约 / router / inject / buffer / store / checkup / indexer
src/adapter/        宿主适配层：dsh.js（唯一知道宿主事件格式的文件）· standalone.js（demo / CI）
examples/mini/      8 条示例清单 + 7 篇中性语料 + demo.mjs
scripts/            尺子：route-probe / trace-stats / keys-clean / skill-doctor / gate
checks/             运维三查：bom / manifest-checkup / handover-lag（统一 JSON 契约）
docs/               BOUNDARY（边界冻结）· WHY · FALSE-GREEN · FAILURES
plugin/             DSH 插件包装 dsh-ctx-manifest：三个只读工具 + 两条只读路由
```

## 两种用法

| 你想干什么 | 用什么 |
|---|---|
| 自己写宿主，只要库 | `import { createEngine } from "ctx-manifest"` |
| 在 DSH 里用 | `plugin/` 里的 `dsh-ctx-manifest`（见 [plugin/README.md](plugin/README.md)） |
| 只想先看一眼 | `node examples/mini/demo.mjs` |

仓库根目录（`src/` `scripts/` `checks/` `docs/` `examples/`）是**原始框架**，不含任何宿主包装；
`plugin/` 只是一层薄壳，通过相对路径 `../../src` 引用这份框架 —— 拆开是为了：不用 DSH 的人拿到干净的库，
用 DSH 的人多装一个目录就有工具、路由和（可选）注入。插件默认 `mode: "off"`，装了不注入。

## 判据（全部可复跑）

| 命令 | 看什么 |
|---|---|
| `node scripts/route-probe.mjs` | 红线 4/4 · 改写 ≥8/10 · 泄漏 0；退出码 0/1 |
| `node scripts/keys-clean.mjs` | 碎片键（n-gram 残片）数量；`--apply` 才删 |
| `node scripts/trace-stats.mjs` | 近 N 天：字符均值 / 分层 / 空转率 / 裁剪 / 悬空 |
| `node checks/manifest-checkup.mjs` | 六类体检，输出 `{id, level, detail}`，CI 可直接吃 |
| `node scripts/gate.mjs` | 发布门：绝对路径 0 处、私人词 0 处 |

## 许可

MIT。没有 CLA —— 小改动直接提 PR 就行。
