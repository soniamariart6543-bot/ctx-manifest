// lib/constants.js —— 纯常量与路径工具（零外部 import）
//
// 为什么单独一件：schema.js 要 import schemastery（插件入口用），而 CLI 必须离线可跑。
// 常量放这里，谁都能引，不会把 schemastery 拖进 CLI 的加载链。

import { join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** 三档运行模式。off = 什么都不挂；shadow = 只算只记 trace；clause = 真注入。 */
export const MODES = ["off", "shadow", "clause"];

/** 注入模式（单元级）。excerpt 才是真拷正文，且只允许 L1。 */
export const INJECT_MODES = ["excerpt", "pointer", "lookup"];

/** 分层。L1 恒注 / L2 条件 / L3 指针 / anchor 环境锚。 */
export const LAYERS = ["L1", "L2", "L3", "anchor"];

/** 分层预算默认值（字符），取自方案 §3.5 的目标列。 */
export const DEFAULT_BUDGETS = { L1: 2300, L2: 900, L3: 400, anchor: 500, total: 4100 };

/**
 * 每层最多命中几个单元（router 的 TopN）。
 * 有它，L2 才不会被「预算之和」误判越界：最坏注入 = TopN × 单条预算。
 */
export const DEFAULT_LIMITS = { L1: 3, L2: 5, L3: 8, anchor: 2 };

/** 层优先级：层内排序用（L1 先于 L2 先于 L3 先于 anchor）。 */
export const LAYER_RANK = { L1: 0, L2: 1, L3: 2, anchor: 3 };

/** DSH_HOME：优先环境变量，否则 ~/.dsh。 */
export const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), ".dsh");

/** 插件根目录（本文件在 <plugin>/lib/ 下，所以上跳一级）。 */
export const PLUGIN_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** 把任意路径解析成绝对路径：~ 开头按 DSH_HOME 祖先展开，绝对路径原样，相对路径按 baseDir。 */
export function toAbs(p, baseDir = DSH_HOME) {
  if (!p) return baseDir;
  let s = String(p).replace(/\\/g, "/");
  if (s === "~") return homedir();
  if (s.startsWith("~/.dsh/")) return join(DSH_HOME, s.slice(7));
  if (s.startsWith("~/")) return join(homedir(), s.slice(2));
  if (/^[A-Za-z]:\//.test(s) || s.startsWith("//")) return resolve(s);
  if (isAbsolute(s)) return resolve(s);
  return resolve(baseDir, s);
}

/** 拆 "path#anchor" → { path, anchor }。anchor 为空表示整份文件。 */
export function splitAnchor(spec) {
  const s = String(spec || "");
  const i = s.indexOf("#");
  if (i < 0) return { path: s, anchor: "" };
  return { path: s.slice(0, i), anchor: s.slice(i + 1) };
}
