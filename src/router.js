// lib/router.js —— 单一分类器（零外部 import）
//
// 全系统**唯一**的触发词表在 memory.manifest.json 的 units[].keys。
// 本文件不含任何业务关键词，只负责：命中判定 → 打分 → 分层 TopN → 拼文本 → 写 trace。
//
// 契约（方案 §3.4）：
//   route(text, opts) → { units: [{id, score, reason}], text, chars, budgetLeft, byLayer }
//
// 判定规则（按优先级）：
//   1) when === "always" → 无条件入列（恒注层），score 固定 1000，reason="when=always"
//   2) keys 里任一关键词出现在文本中 → score = weight*10 + min(8, 最长命中词长) + (命中数-1)*2
//   3) 没命中 → 不入列（闲聊就该 0 命中，这是「闲聊不注」的实现方式）

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { LAYER_RANK, DEFAULT_LIMITS, DSH_HOME, PLUGIN_ROOT, toAbs } from "./constants.js";
import { unitsOf, budgetsOf, limitsOf, resolveUnitPath, budgetOf } from "./manifest.js";
import { buildText, clip } from "./inject.js";
import { detectConflicts, writeBuffer } from "./buffer.js";

/** 归一：NFKC（全角→半角，Ｃ盘→C盘）→ 小写 → 折叠空白。中文不做分词。 */
export function normalize(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 去空白版：`C 盘` / `c盘` / `Ｃ 盘` 归一后都能比对（M1-2 真 bug 修复）。 */
export function normFlat(text) {
  return normalize(text).replace(/\s+/g, "");
}

// ---- M5-2 同义表（单向展开，不做传递闭包：传递会指数爆炸且难解释）----
let SYN_CACHE = null;
let SYN_MTIME = 0;

/** 读 policy/synonyms.json（相对插件根）。格式 { "canonical": ["她说法1","她说法2"] }。 */
export function loadSynonyms(file = process.env.CHENXI_SYNONYMS) {
  const p = file || toAbs("policy/synonyms.json", PLUGIN_ROOT);
  try {
    const st = existsSync(p) ? readFileSync(p, "utf8") : null;
    if (!st) return null;
    const m = (SYN_CACHE && SYN_MTIME) || 0;
    void m;
    if (SYN_CACHE) return SYN_CACHE;
    const raw = JSON.parse(st);
    const pairs = [];
    for (const [canon, alts] of Object.entries(raw)) {
      for (const a of Array.isArray(alts) ? alts : []) {
        const k = normalize(a);
        if (k && k !== normalize(canon)) pairs.push([k, normalize(canon)]);
      }
    }
    // 长的先替换，避免「系统盘」被「盘」抢先
    pairs.sort((x, y) => y[0].length - x[0].length);
    SYN_CACHE = pairs;
    SYN_MTIME = Date.now();
    return SYN_CACHE;
  } catch {
    return null;
  }
}

/** 把文本里的「她的说法」替换成 keys 里的 canonical 形式。 */
export function synExpand(text) {
  const pairs = loadSynonyms();
  if (!pairs || !pairs.length) return "";
  let s = normalize(text);
  for (const [alt, canon] of pairs) {
    if (alt && s.includes(alt)) s = s.split(alt).join(canon);
  }
  return s;
}

/** 单个单元的命中打分。 */
export function scoreUnit(unit, norm, flat = "", syn = "") {
  if (unit.when === "always") {
    return { score: 1000, reason: "when=always", hits: [] };
  }
  const keys = Array.isArray(unit.keys) ? unit.keys : [];
  if (!keys.length) return { score: 0, reason: "", hits: [] };
  const hits = [];
  let longest = 0;
  for (const raw of keys) {
    const k = normalize(raw);
    if (!k) continue;
    if (norm.includes(k)) {
      hits.push(raw);
      if (k.length > longest) longest = k.length;
      continue;
    }
    // 二次比对：去掉全部空白后再比（`C 盘` ↔ `c盘`）。reason 打 @flat，便于审计哪些命中靠去空白
    if (flat && flat.includes(k.replace(/\s+/g, ""))) {
      hits.push(raw + "@flat");
      if (k.length > longest) longest = k.length;
      continue;
    }
    // 第三级：同义展开后比对（`系统盘` → `c盘`）。reason 打 @syn，便于审计是词表赚来的命中
    if (syn && syn.includes(k)) {
      hits.push(raw + "@syn");
      if (k.length > longest) longest = k.length;
    }
  }
  if (!hits.length) return { score: 0, reason: "", hits: [] };
  const weight = typeof unit.weight === "number" ? unit.weight : 1;
  const score = weight * 10 + Math.min(8, longest) + (hits.length - 1) * 2;
  return { score, reason: `keys: ${hits.join(",")}`, hits };
}

/** 全量打分（不过滤）。 */
export function scoreAll(units, text) {
  const norm = normalize(text);
  const flat = normFlat(text);
  const syn = synExpand(text);
  return units.map((u) => {
    const s = scoreUnit(u, norm, flat, syn);
    return { unit: u, id: u.id, layer: u.layer, score: s.score, reason: s.reason, hits: s.hits };
  });
}

/** 排序：层优先级 → 分数降 → id（固定顺序 = 命中集合不变时字节稳定）。 */
function compare(a, b) {
  const ra = LAYER_RANK[a.layer] ?? 9;
  const rb = LAYER_RANK[b.layer] ?? 9;
  if (ra !== rb) return ra - rb;
  if (b.score !== a.score) return b.score - a.score;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * 选择命中单元（分层 TopN）。
 * @returns {Array} 富对象 [{...unit, score, reason}]（已排序，顺序即拼装顺序）
 */
export function select(units, text, { limits = DEFAULT_LIMITS } = {}) {
  const scored = scoreAll(units, text).filter((s) => s.score > 0);
  const picked = [];
  for (const layer of Object.keys(LAYER_RANK)) {
    const group = scored.filter((s) => s.layer === layer).sort(compare);
    const cap = limits[layer] ?? 99;
    for (const s of group.slice(0, cap)) {
      picked.push({ ...s.unit, score: s.score, reason: s.reason, hits: s.hits });
    }
  }
  return picked;
}

/**
 * 主入口：一句话 → 命中单元 + 注入文本 + trace。
 * @param {string} text 用户这句话
 * @param {object} opts { manifest, limits, budgets, mode, trace:boolean, tracePath, turn, dshHome }
 */
export function route(text, opts = {}) {
  const manifest = opts.manifest || { units: [] };
  const units = unitsOf(manifest);
  const limits = { ...limitsOf(manifest), ...(opts.limits || {}) };
  const budgets = { ...budgetsOf(manifest), ...(opts.budgets || {}) };
  const mode = opts.mode || "off";

  const picked = select(units, text, { limits });
  // 两组分离 + 冲突缓冲：同 key 多命中时按 core > rule > knowledge 仲裁，输者进缓冲不注入
  const { kept, buffered } = detectConflicts(picked);
  const built = buildText(kept, { budgets, dshHome: opts.dshHome || DSH_HOME, baseDir: opts.baseDir });

  const budgetLeft = Math.max(0, budgets.total - built.chars);
  const record = {
    ts: nowStamp(),
    mode,
    turn: opts.turn || 0,
    turn_chars: String(text || "").length,
    units: kept.map((u) => u.id),
    chars: built.chars,
    budget_left: budgetLeft,
    by_layer: built.byLayer,
    reasons: kept.map((u) => `${u.id}:${u.reason}`),
    buffered: buffered.length,
    conflicts: buffered.map((b) => `${b.key}:${b.winner}<-${b.loser}`),
    clipped: built.skipped.length,
    dangling: built.dangling.map((d) => d.id),
  };

  if (opts.trace !== false) {
    writeTrace(opts.tracePath || "routing/inject-trace.jsonl", record, opts.dshHome || DSH_HOME);
    if (buffered.length) {
      writeBuffer(buffered, { ts: record.ts, turn: record.turn, dshHome: opts.dshHome || DSH_HOME });
    }
  }

  return {
    units: kept.map((u) => ({ id: u.id, layer: u.layer, score: u.score, reason: u.reason, mode: u.mode })),
    text: built.text,
    chars: built.chars,
    budgetLeft,
    byLayer: built.byLayer,
    skipped: built.skipped,
    dangling: built.dangling,
    buffered,
    trace: record,
  };
}

/** 写一行 trace（JSONL，追加；目录不存在就建）。"./x" 按插件根解析。 */
export function writeTrace(tracePath, record, dshHome = DSH_HOME) {
  const spec = String(tracePath || "");
  const abs = spec.startsWith("./") ? toAbs(spec.slice(2), PLUGIN_ROOT) : toAbs(spec, dshHome);
  try {
    mkdirSync(dirname(abs), { recursive: true });
    appendFileSync(abs, JSON.stringify(record) + "\n", "utf8");
    return abs;
  } catch {
    return null;
  }
}

/** 本地时间戳 "YYYY-MM-DD HH:mm:ss"（不用 toISOString：那是 UTC，会跟日志对不上）。 */
export function nowStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 人读格式：给 CLI 用。 */
export function formatRoute(result, { showText = true } = {}) {
  const lines = [];
  lines.push(`命中 ${result.units.length} 个单元 · ${result.chars} 字符 · 余量 ${result.budgetLeft}`);
  for (const u of result.units) {
    lines.push(`  · ${u.id} [${u.layer}/${u.mode}] score=${u.score}  ${u.reason}`);
  }
  if (!result.units.length) lines.push("  （无命中：闲聊不注）");
  const layerLine = Object.entries(result.byLayer).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(" ");
  if (layerLine) lines.push(`分层字符：${layerLine}`);
  if (result.buffered && result.buffered.length) {
    const detail = result.buffered.map((b) => `${b.key}(${b.winner} 胜 ${b.loser})`).join(" · ");
    lines.push(`冲突缓冲 ${result.buffered.length} 条：${detail}`);
  }
  if (result.dangling.length) lines.push(`悬空：${result.dangling.map((d) => d.id).join(", ")}`);
  if (showText && result.text) {
    lines.push("---- 注入文本 ----");
    lines.push(clip(result.text, 2000));
  }
  return lines.join("\n");
}
