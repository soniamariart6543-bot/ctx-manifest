// lib/indexer.js —— index 声明式编译（--write / --check；零外部 import）
//
// 原则（方案 §4「迁移铁律」+ §6 风险表）：
//   · 索引是**编译产物**，手写表格退役；每行的摘要来自单元 summary 或正文 frontmatter。
//   · 编译只写 INDEX 目标文件本身，**不碰任何正文**；写前先备份。
//   · --check 是判据：产物落后于 manifest 就退非 0（漂移 = 有人改了清单没重编译）。
//
// 本轮（S1–S3）产物落在插件目录 INDEX.generated.md；
// knowledge/INDEX.md 的切换要等 S2 收尾（需用户点头，且它是别人在用的文件）。

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DSH_HOME, PLUGIN_ROOT, toAbs } from "./constants.js";
import { unitsOf, budgetsOf, limitsOf, resolveUnitPath } from "./manifest.js";

export const START = "<!-- chenxi-core:index:start -->";
export const END = "<!-- chenxi-core:index:end -->";

/** 单元 → 索引行（Markdown 表格一行）。 */
export function rowOf(unit, { dshHome = DSH_HOME, state = null } = {}) {
  const { absPath, anchor } = resolveUnitPath(unit, { dshHome });
  const rel = relPath(absPath, dshHome);
  const loc = "`" + rel + (anchor ? "#" + anchor : "") + "`";
  const summary = (unit.summary || unit.title || unit.pointer || "").replace(/\|/g, "\\|").replace(/\s+/g, " ");
  const lastHit = (state?.lastHit?.[unit.id]) || unit.last_hit || "";
  return `| \`${unit.id}\` | ${unit.layer}/${unit.mode} | ${loc} | ${summary} | ${lastHit} |`;
}

function relPath(abs, dshHome) {
  const a = String(abs).replace(/\\/g, "/");
  const h = String(dshHome).replace(/\\/g, "/");
  if (a.toLowerCase().startsWith(h.toLowerCase())) return a.slice(h.length).replace(/^\//, "");
  if (a.toLowerCase().startsWith(String(PLUGIN_ROOT).replace(/\\/g, "/").toLowerCase())) {
    return "./" + a.slice(String(PLUGIN_ROOT).replace(/\\/g, "/").length).replace(/^\//, "");
  }
  return a;
}

/** 渲染整块（含 markers）。rows 按层 → id 固定排序，保证字节稳定。
 *  ⚠️ 编译时间**取 manifest.updated**，不取 now —— 否则 --check 每次都报漂移（幂等性判据）。 */
export function render(manifest, { dshHome = DSH_HOME, state = null, stamp = null } = {}) {
  const compiled = stamp || manifest?.updated || "未标注";
  const units = unitsOf(manifest).slice().sort((a, b) => {
    const ra = ["L1", "L2", "L3", "anchor"].indexOf(a.layer);
    const rb = ["L1", "L2", "L3", "anchor"].indexOf(b.layer);
    if (ra !== rb) return ra - rb;
    return String(a.id).localeCompare(String(b.id));
  });
  const b = budgetsOf(manifest);
  const l = limitsOf(manifest);
  const lines = [];
  lines.push(START);
  lines.push(`> 本区块由 \`node scripts/chenxi.mjs index --write\` 从 memory.manifest.json 编译生成 —— **不要手改**，改了下次 --check 会报漂移。`);
  lines.push(`> 单元 ${units.length} 条 · 预算 L1=${b.L1} / L2=${b.L2} / L3=${b.L3} / anchor=${b.anchor} / total=${b.total} · 每层 TopN L1=${l.L1} / L2=${l.L2} / L3=${l.L3} / anchor=${l.anchor} · 清单日期 ${compiled}`);
  lines.push("");
  lines.push("| 单元 | 层/模式 | 位置 | 摘要 | 最近命中 |");
  lines.push("|---|---|---|---|---|");
  for (const u of units) lines.push(rowOf(u, { dshHome, state }));
  lines.push(END);
  return lines.join("\n");
}

/** 目标文件路径（相对插件根或 DSH_HOME）。 */
export function targetPath(target = "INDEX.generated.md") {
  return target.startsWith("./") ? toAbs(target.slice(2), PLUGIN_ROOT) : toAbs(target, PLUGIN_ROOT);
}

/**
 * --write：把编译结果写入目标文件。
 * 目标已存在且含 markers → 只替换区块（保住别人写的前言）；否则整份重写。
 * 覆盖前先备份（*.bak-<ts>），备份失败就拒绝写。
 */
export function writeIndex(manifest, opts = {}) {
  const abs = targetPath(opts.target);
  const block = render(manifest, opts);
  let existing = null;
  try {
    existing = readFileSync(abs, "utf8");
  } catch {
    existing = null;
  }
  let next = block;
  if (existing && existing.includes(START) && existing.includes(END)) {
    const head = existing.slice(0, existing.indexOf(START));
    const tail = existing.slice(existing.indexOf(END) + END.length);
    next = head + block + tail;
  }
  let backup = "";
  if (existing !== null) {
    backup = `${abs}.bak-${Date.now()}`;
    copyFileSync(abs, backup);
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, next.endsWith("\n") ? next : next + "\n", "utf8");
  return { ok: true, path: abs, backup, bytes: Buffer.byteLength(next, "utf8"), rows: unitsOf(manifest).length };
}

/**
 * --check：产物是否与 manifest 一致。
 * @returns {{ ok: boolean, path: string, reason: string, missing: string[], stale: string[], rows: number }}
 */
export function checkIndex(manifest, opts = {}) {
  const abs = targetPath(opts.target);
  const want = render(manifest, opts);
  let have = null;
  try {
    have = readFileSync(abs, "utf8");
  } catch {
    return { ok: false, path: abs, reason: "产物不存在（先跑 index --write）", missing: [], stale: [], rows: 0 };
  }
  if (!have.includes(START) || !have.includes(END)) {
    return { ok: false, path: abs, reason: "产物里没有 chenxi-core 标记块", missing: [], stale: [], rows: 0 };
  }
  const haveBlock = have.slice(have.indexOf(START), have.indexOf(END) + END.length);
  if (haveBlock === want) {
    return { ok: true, path: abs, reason: "一致", missing: [], stale: [], rows: unitsOf(manifest).length };
  }
  // 逐行比对，报出「缺了哪些单元行 / 多了哪些」
  const wantLines = new Set(want.split("\n").filter((l) => l.startsWith("| `")));
  const haveLines = new Set(haveBlock.split("\n").filter((l) => l.startsWith("| `")));
  const missing = [...wantLines].filter((l) => !haveLines.has(l)).map((l) => String(l).split("`")[1]);
  const stale = [...haveLines].filter((l) => !wantLines.has(l)).map((l) => String(l).split("`")[1]);
  return {
    ok: false, path: abs,
    reason: `漂移：缺 ${missing.length} 行 / 多 ${stale.length} 行（或摘要/日期变了）`,
    missing, stale, rows: haveLines.size,
  };
}

/** 统计产物行数（便于汇报「INDEX 行数」）。 */
export function countRows(absPath) {
  try {
    const text = readFileSync(absPath, "utf8");
    return text.split("\n").filter((l) => l.startsWith("| `")).length;
  } catch {
    return 0;
  }
}

function todayStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export { join };
