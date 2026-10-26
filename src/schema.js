// lib/schema.js —— chenxi-core 的配置契约（插件入口用；CLI 不引本文件）
//
// 只做一件事：用 schemastery 声明 Config。校验 manifest 形状的逻辑在 lib/manifest.js，
// 那边是纯函数、零外部 import —— CLI 才能离线跑。
//
// ⚠️ schemastery 用**动态 import + 顶层 await**：装进 profile 后正常解析（profile/node_modules 里有）；
//    在插件目录里裸跑（没装 node_modules）时降级成普通对象，好让 import 自检不至于直接炸。
//    降级态只影响「配置节校验」，不影响任何工具或路由逻辑。
//
// 默认 mode = "off"：S1–S3 阶段只注册工具与只读路由，不挂任何注入钩子。

import { MODES, DEFAULT_BUDGETS } from "./constants.js";

const mod = await import("@deepseek-ai/schemastery").catch(() => null);
const Schema = mod?.default || mod?.Schema || null;

const spec = () => ({
  mode: ["off", "shadow", "clause"],
  manifestPath: "memory.manifest.json",
  tracePath: "./trace/inject-trace.jsonl",
  indexTarget: "INDEX.generated.md",
  budgets: { ...DEFAULT_BUDGETS },
  lastHit: false,
  trace: true,
});

const descriptions = {
  mode: "off = 只注册工具与只读路由；shadow = 只跑 router 并写 trace（注入空串）；clause = 真注入（S4 才允许）。",
  manifestPath: "记忆单元清单路径。相对路径按插件目录解析；也可写 ~/.dsh 下的相对路径。",
  tracePath: "每轮 trace 落盘位置（\"./\" 开头按插件目录解析；S3 影子期再切 routing/inject-trace.jsonl）。",
  indexTarget: "index 编译产物路径。本轮写在插件目录内，**不写 knowledge/INDEX.md**（S2 收尾才切）。",
  budgets: "分层字符预算；超了 inject.js 会截断并记进 trace。",
  lastHit: "是否给命中单元打 last_hit 时间戳（写插件内 STATE.json，不碰正文文件）。",
  trace: "是否写 trace 行。",
};

export const Config = Schema
  ? (() => {
    const s = Schema.object({
      mode: Schema.union(MODES).default("off").description(descriptions.mode),
      manifestPath: Schema.string().default("memory.manifest.json").description(descriptions.manifestPath),
      tracePath: Schema.string().default("./trace/inject-trace.jsonl").description(descriptions.tracePath),
      indexTarget: Schema.string().default("INDEX.generated.md").description(descriptions.indexTarget),
      budgets: Schema.object({
        L1: Schema.number().default(DEFAULT_BUDGETS.L1),
        L2: Schema.number().default(DEFAULT_BUDGETS.L2),
        L3: Schema.number().default(DEFAULT_BUDGETS.L3),
        anchor: Schema.number().default(DEFAULT_BUDGETS.anchor),
        total: Schema.number().default(DEFAULT_BUDGETS.total),
      }).description(descriptions.budgets),
      lastHit: Schema.boolean().default(false).description(descriptions.lastHit),
      trace: Schema.boolean().default(true).description(descriptions.trace),
    });
    s.meta = { ...(s.meta || {}), description: "chenxi-core：记忆内核（manifest / router / injector / tools）" };
    return s;
  })()
  : spec();

export const hasSchemastery = Boolean(Schema);
export default Config;
