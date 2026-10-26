// lib/manifest.js —— 记忆单元清单的读写 / 校验 / 缓存（零外部 import）
//
// 单一事实源：一个 memory.manifest.json 说清「该注什么、什么条件注、注多少」。
// 本文件只做四件事：读文件（带 mtime 缓存）、校验形状、解析 path#anchor、给单元配套工具函数。
// 不读正文 —— 正文由 inject.js 按需读。

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  LAYERS, INJECT_MODES, DEFAULT_BUDGETS, DEFAULT_LIMITS, PLUGIN_ROOT, DSH_HOME, toAbs, splitAnchor,
} from "./constants.js";

// ---------------------------------------------------------------- 形状校验
// 只支持本插件用到的关键字，够用即可，不引 JSON Schema 库（CLI 得离线跑）。

export const UNIT_REQUIRED = ["id", "path", "layer", "mode"];

export const UNIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: UNIT_REQUIRED,
  properties: {
    id: { type: "string", pattern: "^[a-z][a-zA-Z0-9_.-]*$" },
    title: { type: "string" },
    path: { type: "string" },
    layer: { enum: LAYERS },
    mode: { enum: INJECT_MODES },
    keys: { type: "array", items: { type: "string" } },
    weight: { type: "number" },
    budget: { type: "number" },
    when: { enum: ["always", "match"] },
    sections: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    pointer: { type: "string" },
    note: { type: "string" },
    salience: { type: "number" },
    last_hit: { type: "string" },
    // 2026-10-25 加：分流分区标签（system / toolchain / dev / doc / net / design / game / academic / life / memory）。
    // 只作检索与清单分组用，不参与注入预算；打标脚本 wf/tag-subgroups.mjs。
    subgroup: { type: "string" },
  },
};

/** 豁免条目：显式声明「这个文件不登记成单元」，并写清理由与判断依据。 */
export const EXCLUDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path", "reason"],
  properties: {
    path: { type: "string" },
    reason: { type: "string" },
    kind: { type: "string" },   // 副本 / 流水账 / 产物 / 简报 / 分册 …
  },
};

export const MANIFEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "units"],
  properties: {
    version: { type: "number" },
    updated: { type: "string" },
    note: { type: "string" },
    budgets: {
      type: "object",
      additionalProperties: false,
      properties: {
        L1: { type: "number" }, L2: { type: "number" },
        L3: { type: "number" }, anchor: { type: "number" }, total: { type: "number" },
      },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        L1: { type: "number" }, L2: { type: "number" },
        L3: { type: "number" }, anchor: { type: "number" },
      },
    },
    units: { type: "array", items: UNIT_SCHEMA },
    exclude: { type: "array", items: EXCLUDE_SCHEMA },
  },
};

/** 极简 JSON Schema 校验，返回错误串数组（空数组 = 通过）。 */
export function validate(node, schema, at = "$") {
  const errs = [];
  if (!schema || typeof schema !== "object") return errs;
  if (schema.enum) {
    if (!schema.enum.includes(node)) {
      errs.push(`${at}: 取值 ${JSON.stringify(node)} 不在 ${JSON.stringify(schema.enum)} 里`);
    }
    return errs;
  }
  if (schema.type === "object") {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      errs.push(`${at}: 应为对象`);
      return errs;
    }
    for (const k of schema.required || []) {
      if (node[k] === undefined) errs.push(`${at}.${k}: 必填缺失`);
    }
    const props = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(node)) {
        if (!(k in props)) errs.push(`${at}.${k}: 未声明的字段`);
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (node[k] !== undefined) errs.push(...validate(node[k], sub, `${at}.${k}`));
    }
    return errs;
  }
  if (schema.type === "array") {
    if (!Array.isArray(node)) { errs.push(`${at}: 应为数组`); return errs; }
    node.forEach((v, i) => errs.push(...validate(v, schema.items, `${at}[${i}]`)));
    return errs;
  }
  if (schema.type === "string") {
    if (typeof node !== "string") { errs.push(`${at}: 应为字符串`); return errs; }
    if (schema.pattern && !new RegExp(schema.pattern).test(node)) {
      errs.push(`${at}: ${JSON.stringify(node)} 不匹配 ${schema.pattern}`);
    }
    return errs;
  }
  if (schema.type === "number") {
    if (typeof node !== "number" || !Number.isFinite(node)) errs.push(`${at}: 应为数字`);
    return errs;
  }
  return errs;
}

// ---------------------------------------------------------------- 读取与缓存

const cache = new Map(); // absPath -> { mtimeMs, manifest, errors }

/** 把配置里的 manifestPath 解析成绝对路径。 */
export function resolveManifestPath(p, baseDir = PLUGIN_ROOT) {
  return toAbs(p || "memory.manifest.json", baseDir);
}

/**
 * 读 manifest（mtime 不变就走缓存）。
 * @returns {{ ok: boolean, path: string, manifest: object|null, errors: string[], mtimeMs: number }}
 */
export function loadManifest(path, { force = false, baseDir = PLUGIN_ROOT } = {}) {
  const abs = resolveManifestPath(path, baseDir);
  let st;
  try {
    st = statSync(abs);
  } catch (err) {
    return { ok: false, path: abs, manifest: null, errors: [`读不到 manifest：${abs}（${err.code || err.message}）`], mtimeMs: 0 };
  }
  const hit = cache.get(abs);
  if (!force && hit && hit.mtimeMs === st.mtimeMs) return { ...hit, ok: hit.errors.length === 0, path: abs };

  let manifest = null;
  const errors = [];
  try {
    const raw = readFileSync(abs, "utf8");
    manifest = JSON.parse(raw);
  } catch (err) {
    errors.push(`manifest 解析失败：${err.message}`);
  }
  if (manifest) {
    errors.push(...validate(manifest, MANIFEST_SCHEMA, "$"));
    const ids = new Set();
    for (const u of manifest.units || []) {
      if (u && u.id) {
        if (ids.has(u.id)) errors.push(`$.units: id 重复 ${u.id}`);
        ids.add(u.id);
      }
      // 三条语义约束（形状对了不代表说得通）
      if (u && u.mode === "excerpt" && u.layer !== "L1") {
        errors.push(`$.units[${u.id}]: mode=excerpt 只允许 L1（现在是 ${u.layer}）`);
      }
      if (u && u.when === "always" && Array.isArray(u.keys) && u.keys.length) {
        errors.push(`$.units[${u.id}]: when=always 与 keys 互斥（恒注不看关键词）`);
      }
      if (u && (u.budget === undefined) && u.mode !== "lookup") {
        errors.push(`$.units[${u.id}]: ${u.mode} 模式必须给 budget（0 = 只登记不注入）`);
      }
    }
  }
  const rec = { mtimeMs: st.mtimeMs, manifest, errors };
  cache.set(abs, rec);
  return { ok: errors.length === 0, path: abs, manifest, errors, mtimeMs: st.mtimeMs };
}

/** 清缓存（测试与 --write 之后用）。 */
export function clearManifestCache() {
  cache.clear();
}

/** 取单元集合（已校验通过才有意义）。 */
export function unitsOf(manifest) {
  return Array.isArray(manifest?.units) ? manifest.units : [];
}

/** manifest 的分层预算，缺项用默认值补齐。 */
export function budgetsOf(manifest) {
  const b = manifest?.budgets || {};
  return {
    L1: numOr(b.L1, DEFAULT_BUDGETS.L1),
    L2: numOr(b.L2, DEFAULT_BUDGETS.L2),
    L3: numOr(b.L3, DEFAULT_BUDGETS.L3),
    anchor: numOr(b.anchor, DEFAULT_BUDGETS.anchor),
    total: numOr(b.total, DEFAULT_BUDGETS.total),
  };
}

function numOr(v, d) {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/** 每层 TopN 上限，缺项用默认值补齐。 */
export function limitsOf(manifest) {
  const l = manifest?.limits || {};
  return {
    L1: numOr(l.L1, DEFAULT_LIMITS.L1),
    L2: numOr(l.L2, DEFAULT_LIMITS.L2),
    L3: numOr(l.L3, DEFAULT_LIMITS.L3),
    anchor: numOr(l.anchor, DEFAULT_LIMITS.anchor),
  };
}

/**
 * 单元 → 绝对路径 + 锚点。
 * path 写法约定：
 *   "./x"        相对插件根（本插件自带文件，如 skills/memory.md）
 *   "~/..."      家目录
 *   "persona/..."相对 DSH_HOME（默认，记忆正文都在 ~/.dsh 下）
 *   绝对路径     原样
 */
export function resolveUnitPath(unit, { baseDir, dshHome, ...rest } = {}) {
  const { path, anchor } = splitAnchor(unit?.path);
  if (!path) return { absPath: "", anchor: "" };
  // 根目录三选一：baseDir（新口径）→ dshHome（旧口径，checkup 里一直用它）→ DSH_HOME（缺省）
  // 2026-10-26 修：以前只认 baseDir，导致宿主传 dshHome 时示例语料全被判悬空
  const root = baseDir || dshHome || DSH_HOME;
  const abs = path.startsWith("./") ? toAbs(path.slice(2), PLUGIN_ROOT) : toAbs(path, root);
  return { absPath: abs, anchor: anchor ? normalizeAnchor(anchor) : "" };
}

/** 锚点统一成「不含 # 与多余空格」的标题文本；"17" 这类纯数字按 §17 理解。 */
export function normalizeAnchor(a) {
  let s = String(a || "").trim().replace(/^#+/, "");
  if (/^\d+(\.\d+)*$/.test(s)) s = `§${s}`;
  else if (/^§/.test(s)) s = s.replace(/^§\s*/, "§");
  return s;
}

/** 单元的有效预算：显式 budget 优先，缺省按模式给（excerpt 400 / pointer 160 / lookup 0）。 */
export function budgetOf(unit) {
  if (typeof unit?.budget === "number") return unit.budget;
  if (unit?.mode === "excerpt") return 400;
  if (unit?.mode === "pointer") return 160;
  return 0;
}

/** 豁免清单：把 exclude[].path 解析成绝对路径集合（口径与单元 path 一致）。 */
export function excludesOf(manifest, { dshHome = DSH_HOME } = {}) {
  const list = Array.isArray(manifest?.exclude) ? manifest.exclude : [];
  return list.map((e) => {
    const p = String(e?.path || "");
    const abs = p.startsWith("./") ? toAbs(p.slice(2), PLUGIN_ROOT) : toAbs(p, dshHome);
    return { absPath: abs, reason: String(e?.reason || ""), kind: String(e?.kind || "") };
  });
}

/** 单元排序键：层 → id（固定排序 = 命中集合不变时字节必须相同，防 KV cache 抖动）。 */export function sortUnits(a, b) {
  const ra = LAYERS.indexOf(a.layer);
  const rb = LAYERS.indexOf(b.layer);
  if (ra !== rb) return ra - rb;
  return String(a.id).localeCompare(String(b.id));
}

/** 按 id 建索引。 */
export function indexById(units) {
  const m = new Map();
  for (const u of units) if (u && u.id) m.set(u.id, u);
  return m;
}

/** 供 inspect / CLI 用的清单摘要。 */
export function summarize(manifest) {
  const units = unitsOf(manifest);
  const by = { L1: 0, L2: 0, L3: 0, anchor: 0 };
  const byMode = { excerpt: 0, pointer: 0, lookup: 0 };
  for (const u of units) {
    if (by[u.layer] !== undefined) by[u.layer] += 1;
    if (byMode[u.mode] !== undefined) byMode[u.mode] += 1;
  }
  return { total: units.length, byLayer: by, byMode, budgets: budgetsOf(manifest) };
}

export { resolve as _resolve };
