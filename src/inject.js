// lib/inject.js —— 分层预算 + 文本拼装 + 悬空指针检查（零外部 import）
//
// 三条注入模式（方案 §3.3）：
//   excerpt  真正把正文拷进上下文（只允许 L1；按 sections 抽 ## 段）
//   pointer  只给一行指针（"→ 文件#锚点"或单元自带 pointer）
//   lookup   连指针都不给，只登记（budget 0 = 只登记不注入）
//
// 预算：先按层给额度，层内按 router 给的排序逐条累加，单条再受 unit.budget 截断；
// 超预算就停（并记 skipped），整体再受 total 兜底。

import { readFileSync, existsSync } from "node:fs";
import { DEFAULT_BUDGETS, LAYER_RANK, DSH_HOME } from "./constants.js";
import { resolveUnitPath, budgetOf } from "./manifest.js";

/** 层标题（拼装时用，方便 trace 与人工核对）。 */
const LAYER_LABEL = {
  L1: "【L1 恒注】",
  L2: "【L2 条件】",
  L3: "【L3 指针】",
  anchor: "【环境锚】",
};

/** 读文件（容错；读不到返回 null，由调用方记悬空）。 */
export function readTextSafe(absPath) {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

/**
 * 按 "## 标题" 抽若干段。标题匹配规则：归一后相等 → 包含 → 被包含，取第一个命中。
 * 段尾 = 下一个同级或更高级标题。找不到的段返回 null（调用方据此报悬空锚点）。
 */
export function extractSection(text, wanted) {
  if (!text) return null;
  const want = normalizeHeading(wanted);
  if (!want) return null;
  const lines = text.split(/\r?\n/);
  const heads = [];
  lines.forEach((line, i) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) heads.push({ level: m[1].length, title: m[2].trim(), line: i });
  });
  let hitIdx = heads.findIndex((h) => normalizeHeading(h.title) === want);
  if (hitIdx < 0) hitIdx = heads.findIndex((h) => normalizeHeading(h.title).includes(want));
  if (hitIdx < 0) hitIdx = heads.findIndex((h) => want.includes(normalizeHeading(h.title)));
  if (hitIdx < 0) return null;
  const start = heads[hitIdx].line;
  const level = heads[hitIdx].level;
  let end = lines.length;
  for (let j = hitIdx + 1; j < heads.length; j += 1) {
    if (heads[j].level <= level) { end = heads[j].line; break; }
  }
  return lines.slice(start, end).join("\n").trim();
}

function normalizeHeading(s) {
  return String(s || "")
    .replace(/^#+\s*/, "")
    .replace(/[★*`]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/** 锚点定位：支持 "§17"（数字节）与标题文本两种写法；返回命中的段文本或 null。 */
export function extractAnchor(text, anchor) {
  if (!text || !anchor) return null;
  const a = String(anchor).trim();
  const num = /^§\s*(\d+)/.exec(a);
  if (num) {
    const n = num[1];
    // 优先 "## 17." / "## 17 " 这种二级标题
    const direct = extractSection(text, `${n}.`);
    if (direct) return direct;
    const re = new RegExp(`^#{1,6}\\s*${n}[.、\\s]`, "m");
    const lines = text.split(/\r?\n/);
    const idx = lines.findIndex((l) => re.test(l));
    if (idx < 0) return null;
    const level = (/^#+/.exec(lines[idx]) || ["#"])[0].length;
    let end = lines.length;
    for (let j = idx + 1; j < lines.length; j += 1) {
      const m = /^(#{1,6})\s+/.exec(lines[j]);
      if (m && m[1].length <= level) { end = j; break; }
    }
    return lines.slice(idx, end).join("\n").trim();
  }
  return extractSection(text, a);
}

/** 截断到 n 字符，尽量断在句子边界。 */
export function clip(text, n) {
  const s = String(text || "");
  if (!Number.isFinite(n) || n <= 0) return "";
  if (s.length <= n) return s;
  const head = s.slice(0, Math.max(0, n - 1));
  const cut = Math.max(head.lastIndexOf("。"), head.lastIndexOf("\n"), head.lastIndexOf("；"));
  return (cut > n * 0.6 ? head.slice(0, cut + 1) : head) + "…";
}

/** 悬空检查：文件在不在、锚点在不在。返回 { ok, level, detail }。 */
export function checkDangling(unit, opts = {}) {
  const { absPath, anchor } = resolveUnitPath(unit, opts);
  if (!absPath) return { ok: false, level: "error", detail: "path 为空" };
  if (!existsSync(absPath)) return { ok: false, level: "error", detail: `文件不存在：${absPath}` };
  if (!anchor) return { ok: true, level: "ok", detail: absPath };
  const text = readTextSafe(absPath);
  if (text === null) return { ok: false, level: "error", detail: `读不到：${absPath}` };
  const seg = extractAnchor(text, anchor);
  if (!seg) return { ok: false, level: "error", detail: `锚点找不到：#${anchor} @ ${absPath}` };
  return { ok: true, level: "ok", detail: `${absPath}#${anchor}` };
}

/** 单条单元的注入文本（不含层头）。返回 { text, chars, dangling }。 */
export function renderUnit(unit, opts = {}) {
  const cap = budgetOf(unit);
  if (cap <= 0) {
    return { text: "", chars: 0, dangling: null, skipped: "budget=0（只登记不注入）" };
  }
  if (unit.mode === "lookup") {
    // 2026-10-21：lookup 从「只登记」改为「投一行摘要 + 路径」——L3 记忆命中不再静默。
    // 预算由 manifest 单条 budget 控制（默认 80），TopN 6 × 80 = 480 ≤ L3 层预算 800。
    const { absPath, anchor } = resolveUnitPath(unit, opts);
    const summary = String(unit.summary || "").trim();
    // 指针用 unit.path（相对 DSH_HOME，短且人能读）；absPath 只在没有 path 时兜底。
    const rel = unit.path || absPath;
    const line = `· ${unit.title || unit.id} → ${rel}${!unit.path && anchor ? "#" + anchor : ""}${summary ? "：" + summary : ""}`;
    const text = clip(line, cap);
    return { text, chars: text.length, dangling: null, skipped: null };
  }
  if (unit.mode === "pointer") {
    const line = unit.pointer || (() => {
      const { absPath, anchor } = resolveUnitPath(unit, opts);
      return `→ ${absPath}${anchor ? "#" + anchor : ""}`;
    })();
    const text = `· ${line}`;
    return { text: clip(text, cap), chars: Math.min(text.length, cap), dangling: null, skipped: null };
  }
  // excerpt：真拷正文
  const { absPath, anchor } = resolveUnitPath(unit, opts);
  const body = readTextSafe(absPath);
  if (body === null) {
    return { text: `· [悬空] ${unit.id} → ${absPath}`, chars: 0, dangling: `文件不存在：${absPath}`, skipped: null };
  }
  let picked = "";
  const dangles = [];
  if (Array.isArray(unit.sections) && unit.sections.length) {
    const parts = [];
    for (const sec of unit.sections) {
      const seg = extractSection(body, sec);
      if (seg) parts.push(seg);
      else dangles.push(`段「${sec}」在 ${absPath} 里找不到`);
    }
    picked = parts.join("\n\n");
  } else if (anchor) {
    const seg = extractAnchor(body, anchor);
    if (seg) picked = seg;
    else dangles.push(`锚点 #${anchor} 在 ${absPath} 里找不到`);
  } else {
    picked = body;
  }
  if (!picked) {
    return {
      text: `· [悬空] ${unit.id} → ${absPath}${anchor ? "#" + anchor : ""}`,
      chars: 0,
      dangling: dangles.join("；") || "取不到正文",
      skipped: null,
    };
  }
  const text = clip(picked.trim(), cap);
  return { text, chars: text.length, dangling: dangles.length ? dangles.join("；") : null, skipped: null };
}

/**
 * 分层拼装。
 * @param {Array} units router 已排好序的命中单元（含 score/reason）
 * @param {object} opts { budgets, layerOrder, dshHome, includeLayerHeaders }
 * @returns {{ text, chars, byLayer, used, skipped, dangling }}
 */
export function buildText(units, opts = {}) {
  const budgets = { ...DEFAULT_BUDGETS, ...(opts.budgets || {}) };
  const byLayer = { L1: 0, L2: 0, L3: 0, anchor: 0 };
  const used = [];
  const skipped = [];
  const dangling = [];
  const blocks = [];
  let total = 0;

  const order = Object.keys(byLayer).sort((a, b) => LAYER_RANK[a] - LAYER_RANK[b]);
  for (const layer of order) {
    const group = units.filter((u) => u.layer === layer);
    if (!group.length) continue;
    const lines = [];
    for (const u of group) {
      const r = renderUnit(u, opts);
      if (r.dangling) dangling.push({ id: u.id, detail: r.dangling });
      if (!r.text) {
        skipped.push({ id: u.id, why: r.skipped || "空" });
        used.push({ id: u.id, layer, chars: 0, empty: true });
        continue;
      }
      const layerLeft = budgets[layer] - byLayer[layer];
      const totalLeft = budgets.total - total;
      const room = Math.min(layerLeft, totalLeft);
      if (room <= 0) {
        skipped.push({ id: u.id, why: `预算用尽（${layer}）` });
        continue;
      }
      const text = r.text.length > room ? clip(r.text, room) : r.text;
      lines.push(text);
      byLayer[layer] += text.length;
      total += text.length;
      used.push({ id: u.id, layer, chars: text.length });
    }
    if (lines.length) {
      const head = opts.includeLayerHeaders === false ? "" : LAYER_LABEL[layer] + "\n";
      blocks.push(head + lines.join("\n"));
    }
  }

  const text = blocks.join("\n\n");
  return { text, chars: text.length, byLayer, total, used, skipped, dangling, budgets };
}

/** 一层一句话摘要（trace / CLI 用）。 */
export function summarizeByLayer(byLayer) {
  return Object.entries(byLayer)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

export { DSH_HOME };
