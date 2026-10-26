// lib/store.js —— 记忆单元的扫描 / frontmatter 解析 / last_hit 打戳（零外部 import）
//
// 边界（硬约束）：**正文只读**。本文件不往 knowledge / persona / growth 里写任何字节；
// 唯一的写是插件自己的 STATE.json（记录 last_hit / turn 计数）。这是「不存第二份真相」的落地方式。
//
// frontmatter 约定（方案 §2.2，采自 dsh-plugin-memory）：
//   ---
//   summary: 一句话摘要
//   type: rule | memory | standard | project
//   tags: [a, b]
//   salience: 7
//   last_hit: 2026-10-21
//   ---

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { DSH_HOME, PLUGIN_ROOT, toAbs } from "./constants.js";
import { unitsOf, resolveUnitPath, excludesOf } from "./manifest.js";

export const STATE_PATH = join(PLUGIN_ROOT, "STATE.json");

// ---------------------------------------------------------------- frontmatter

/** 解析 frontmatter。没有 frontmatter 时 data 为空对象、body 为原文。 */
export function parseFrontmatter(text) {
  const s = String(text || "");
  if (!s.startsWith("---")) return { data: {}, body: s, has: false };
  const lines = s.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end < 0) return { data: {}, body: s, has: false };
  const data = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      data[m[1]] = v.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else if (v === "true" || v === "false") {
      data[m[1]] = v === "true";
    } else if (/^-?\d+(\.\d+)?$/.test(v)) {
      data[m[1]] = Number(v);
    } else {
      data[m[1]] = v.replace(/^["']|["']$/g, "");
    }
  }
  return { data, body: lines.slice(end + 1).join("\n"), has: true };
}

/** 从正文首段推一个摘要（没 frontmatter 时兜底；跳过引用块与空行）。 */
export function inferSummary(body, max = 80) {
  const lines = String(body || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith(">")) continue;
    if (line.startsWith("|")) continue;
    if (line.startsWith("---")) continue;
    const plain = line.replace(/[*`_]/g, "").replace(/\s+/g, " ");
    return plain.length > max ? plain.slice(0, max - 1) + "…" : plain;
  }
  return "";
}

// ---------------------------------------------------------------- 扫描

/** 递归列 .md 文件（深度受限，跳过 node_modules / archive / backup）。 */
export function listMarkdown(root, { depth = 2, skip = ["node_modules", "archive", "backup", ".git", "sessions", "literary-src"] } = {}) {
  const out = [];
  if (!existsSync(root)) return out;
  const walk = (dir, d) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".agent-presets") continue;
      if (skip.includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (d > 0) walk(p, d - 1);
      } else if (extname(e.name).toLowerCase() === ".md") {
        out.push(p);
      }
    }
  };
  walk(root, depth);
  return out;
}

/** 读一个 .md 的单元元数据。 */
export function readUnitFile(absPath) {
  const st = statSync(absPath);
  const text = readFileSync(absPath, "utf8");
  const { data, body, has } = parseFrontmatter(text);
  return {
    absPath,
    name: basename(absPath),
    bytes: st.size,
    mtime: st.mtime.toISOString().slice(0, 10),
    mtimeMs: st.mtimeMs,
    hasFrontmatter: has,
    summary: data.summary || inferSummary(body),
    type: data.type || "",
    tags: Array.isArray(data.tags) ? data.tags : [],
    salience: typeof data.salience === "number" ? data.salience : null,
    last_hit: data.last_hit || "",
    headings: (body.match(/^#{1,3}\s.+$/gm) || []).length,
  };
}

/**
 * 扫记忆树（默认 knowledge + persona + growth），返回单元元数据数组。
 * @param {string[]} roots 相对 DSH_HOME 的目录
 */
export function scanStore({
  roots = ["knowledge", "persona", ".agent-presets/chenxi/growth", ".agent-presets/chenxi/standards"],
  dshHome = DSH_HOME,
  depth = 1,
} = {}) {
  const items = [];
  for (const rel of roots) {
    for (const p of listMarkdown(toAbs(rel, dshHome), { depth })) {
      try {
        items.push(readUnitFile(p));
      } catch {
        /* 读不到就跳过，checkup 会从「覆盖缺口」侧体现 */
      }
    }
  }
  return items;
}

/**
 * 覆盖缺口：清单里登记的文件集合 vs 实际扫到的文件集合。
 * 豁免（manifest.exclude）单独算，不混进「缺口」—— 但也要校验豁免本身有效：
 *   · 豁免了一个不存在的文件 → invalid（写错了路径）
 *   · 豁免了一个已被单元登记的文件 → redundant（重复声明）
 * @returns {{ unregistered, missing, excluded, invalidExclude, redundantExclude, registered, scanned }}
 */
export function coverage(manifest, { dshHome = DSH_HOME } = {}) {
  const registered = new Set();
  const missing = [];
  for (const u of unitsOf(manifest)) {
    const { absPath } = resolveUnitPath(u, { dshHome });
    if (!absPath) continue;
    registered.add(normPath(absPath));
    if (!existsSync(absPath)) missing.push(absPath);
  }
  const scanned = scanStore({ dshHome });

  const exDecl = excludesOf(manifest, { dshHome });
  const excludedSet = new Set(exDecl.map((e) => normPath(e.absPath)));
  const invalidExclude = [];
  const redundantExclude = [];
  for (const e of exDecl) {
    if (registered.has(normPath(e.absPath))) redundantExclude.push(e.absPath);
    else if (!existsSync(e.absPath)) invalidExclude.push(e.absPath);
  }

  const unregistered = [];
  let excludedHit = 0;
  for (const it of scanned) {
    // frontmatter 里带 type: index / corpus 的明确不登记（索引页 / 语料产物）
    if (it.type === "index" || it.type === "corpus") continue;
    const key = normPath(it.absPath);
    if (registered.has(key)) continue;
    if (excludedSet.has(key)) { excludedHit += 1; continue; }
    unregistered.push(it.absPath);
  }
  return {
    unregistered, missing,
    excluded: excludedHit,
    excludedTotal: exDecl.length,
    invalidExclude, redundantExclude,
    registered: registered.size, scanned: scanned.length,
  };
}

function normPath(p) {
  return String(p).replace(/\\/g, "/").toLowerCase();
}

// ---------------------------------------------------------------- STATE / last_hit

export function readState(statePath = STATE_PATH) {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { version: 1, turn: 0, lastHit: {}, firstSeen: {} };
  }
}

export function writeState(state, statePath = STATE_PATH) {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 给命中单元打 last_hit 戳（写 STATE.json，不碰正文）。返回更新后的 STATE。 */
export function stampLastHit(ids, { statePath = STATE_PATH, ts = today(), bumpTurn = false } = {}) {
  const state = readState(statePath);
  state.lastHit = state.lastHit || {};
  state.firstSeen = state.firstSeen || {};
  const list = Array.isArray(ids) ? ids : [ids];
  for (const id of list) {
    if (!id) continue;
    state.lastHit[id] = ts;
    if (!state.firstSeen[id]) state.firstSeen[id] = ts;
  }
  if (bumpTurn) state.turn = (state.turn || 0) + 1;
  state.updated = ts;
  writeState(state, statePath);
  return state;
}

/** 单元「多久没被命中」（天）。没记录返回 null。 */
export function daysSinceHit(id, statePath = STATE_PATH) {
  const state = readState(statePath);
  const last = state.lastHit?.[id];
  if (!last) return null;
  const then = Date.parse(last + "T00:00:00");
  if (!Number.isFinite(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}

export function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export { DSH_HOME, PLUGIN_ROOT };
