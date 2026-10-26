// src/bootstrap.js —— 宿主无关的装配核心
//
// 这一层只做一件事：**把一句话变成「注入了哪些单元 + 为什么」**。
// 它不 import 任何宿主 SDK，也不知道用户是谁、机器是哪台 —— 宿主差异全部由 adapter 承担。
//
// adapter 契约（唯一要求的四个方法，前两个必选）：
//   getTurnText()        → string            本轮用户说了什么（宿主自己知道去哪个事件流里找）
//   applyContext(text)   → void | string     把装配结果交回宿主（或直接返回给调用方）
//   registerSkill(skill) → boolean|void      可选：把随包技能暴露成宿主技能
//   log(line)            → void              可选：日志出口（缺省走 console）
//
// 用法（standalone）：
//   const engine = createEngine({ adapter, manifestPath, config });
//   const out = engine.turn();     // 读一句话 → 路由 → 交回 adapter
//   engine.checkup();              // 六类体检
//   engine.stats();                // 预算与命中统计

import { loadManifest } from "./manifest.js";
import { route } from "./router.js";
import { checkup as runCheckup, formatReport } from "./checkup.js";
import { readState, stampLastHit } from "./store.js";

const NOOP = () => {};

/** 契约校验：缺必选方法就直接报错，别等到注入静默失效才发现。 */
function assertAdapter(adapter) {
  for (const m of ["getTurnText", "applyContext"]) {
    if (typeof adapter?.[m] !== "function") throw new Error(`adapter 缺少必选方法：${m}()`);
  }
}

/**
 * @param {object} opts
 * @param {object} opts.adapter       宿主适配器（见上）
 * @param {string} opts.manifestPath  清单路径（必填，不猜默认值）
 * @param {object} [opts.config]      { mode, trace, tracePath, lastHit, budgets, limits }
 * @returns {{ turn:Function, checkup:Function, stats:Function, manifest:Function, reload:Function }}
 */
export function createEngine({ adapter, manifestPath, config = {} }) {
  assertAdapter(adapter);
  if (!manifestPath) throw new Error("createEngine 需要 manifestPath（不猜默认路径）");

  const mode = config.mode || "clause";
  const log = typeof adapter.log === "function" ? adapter.log : NOOP;
  let cached = null;

  function manifest() {
    if (cached) return cached;
    const loaded = loadManifest(manifestPath, { force: false });
    if (!loaded.ok) {
      log(`[manifest] 校验失败：${JSON.stringify(loaded.errors?.slice(0, 3) || [])}`);
      return null;
    }
    cached = loaded.manifest || loaded;
    return cached;
  }

  function reload() {
    cached = null;
    return manifest();
  }

  /** 一轮：取文本 → 路由 → 交回宿主。返回路由结果（含命中理由与字符数）。 */
  function turn() {
    const m = manifest();
    if (!m) return { units: [], text: "", chars: 0, why: "manifest 不可用" };
    let input = "";
    try {
      input = String(adapter.getTurnText() || "");
    } catch (err) {
      log(`[adapter] getTurnText 失败：${(err && err.message) || err}`);
      return { units: [], text: "", chars: 0, why: "取不到本轮文本" };
    }
    if (!input.trim()) return { units: [], text: "", chars: 0, why: "空输入（闲聊不注）" };

    const state = (() => {
      try { return readState() || {}; } catch { return {}; }
    })();
    const res = route(input, {
      manifest: m,
      mode,
      trace: config.trace !== false,
      tracePath: config.tracePath || "./trace/inject-trace.jsonl",
      turn: state.turn || 0,
      budgets: config.budgets,
      limits: config.limits,
      // 单元里的相对 path 按 baseDir 解析（demo 用 examples/mini 当「家目录」，宿主用真实的目录）
      dshHome: config.home,
      baseDir: config.home,
    });
    if (config.lastHit) {
      try { stampLastHit(res.units.map((u) => u.id), { bumpTurn: true }); } catch { /* 打戳失败不影响注入 */ }
    }
    const text = mode === "clause" ? res.text : "";
    try { adapter.applyContext(text); } catch (err) {
      log(`[adapter] applyContext 失败：${(err && err.message) || err}`);
    }
    return res;
  }

  function checkup() {
    const m = manifest();
    if (!m) return { ok: false, why: "manifest 不可用" };
    return runCheckup(m, { dshHome: config.home });
  }

  function stats() {
    const m = manifest();
    if (!m) return null;
    const units = m.units || [];
    const byLayer = {};
    let budget = 0;
    for (const u of units) {
      byLayer[u.layer] = (byLayer[u.layer] || 0) + 1;
      budget += Number(u.budget || 0);
    }
    return { units: units.length, byLayer, budgetSum: budget, budgets: m.budgets || null };
  }

  return { turn, checkup, stats, manifest, reload, formatReport };
}
