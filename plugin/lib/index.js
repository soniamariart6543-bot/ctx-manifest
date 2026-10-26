// plugin/lib/index.js —— dsh-ctx-manifest 插件入口
//
// 这一层只做一件事：把 repo 里的 ctx-manifest 内核挂到 DSH 上，并注册三个只读工具。
// 宿主差异全部在 src/adapter/dsh.js（唯一的宿主感知文件），这里不重复判断宿主能力。
//
// 默认 mode = "off"：
//   · 注册三个只读工具（probe / checkup / status）—— 随时可用
//   · 挂两条只读路由 /api/ctx-manifest/{status,checkup} —— 宿主支持 webServer 时
//   · 不注入任何上下文。要真注入才显式配 mode: "shadow"（只算 + 写 trace）或 "clause"。
//
// 为什么不默认挂注入：注入是改 system prompt 的行为。默认关掉，装的人先看得见、再决定开。

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mount } from "../../src/adapter/dsh.js";
import { registerTools } from "./tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 没配 manifestPath 时用仓库自带示例清单（内核明确不猜默认路径，所以这里必须给一个）。 */
const DEFAULT_MANIFEST = resolve(HERE, "../../examples/mini/manifest.json");

export const name = "dsh-ctx-manifest";

/** 只声明 tools；webServer / systemPrompt 由 adapter 内部按需 inject。 */
export const inject = ["tools"];

export function apply(ctx, config = {}) {
  const cfg = config || {};
  const mode = String(cfg.mode || "off");
  const manifestPath = resolve(String(cfg.manifestPath || DEFAULT_MANIFEST));
  // 内核用 config.home 解析清单里的相对 path（demo 把 examples/mini 当「家」）。
  // 没显式配 home 时，退到清单所在目录 —— 绝不落到某个人的真实 ~/.dsh。
  const config2 = { ...cfg, home: cfg.home || dirname(manifestPath) };

  const { engine } = mount({ ctx, config: config2, manifestPath });
  const registered = registerTools(ctx, config2, engine, manifestPath);

  try {
    console.log(`[dsh-ctx-manifest] mode=${mode} · 工具 ${registered} 个 · 清单 ${manifestPath}`);
    console.log(`[dsh-ctx-manifest] 只读路由 /api/ctx-manifest/{status,checkup}`);
  } catch {
    /* 日志失败不影响插件 */
  }
}

export default { name, inject, apply };
