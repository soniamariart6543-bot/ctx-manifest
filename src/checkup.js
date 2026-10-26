// lib/checkup.js —— 体检：一份报告，六类检查，有问题退非 0（零外部 import）
//
// 六类（方案 §3.2 / §8 判据「体检可读」；第 5 类 2026-10-25 加，第 6 类同日加）：
//   1. 悬空引用   单元 path 不存在 / #锚点在文件里找不到
//   2. 过期单元   命中记录太久（salience 高的给更宽限期）/ 正文 mtime 太久没动 / 从未命中（L1·anchor 判 error、L2 判 warn）
//   3. 预算越界   每层 TopN × 单条预算 > 层预算；分层之和 > total；单条超总预算；占用 ≥95% 提前 warn
//   4. 覆盖缺口   知识库里有 .md 没被任何单元登记（与 manifest 的登记集合比对）
//   5. 冲突缓冲   同一 key 反复撞车（两组分离的配套检查）
//   6. 索引事实   索引里可机械核对的数字（「（N 节）」「N 个会话」）与实体比对 —— 反「假绿灯」
//
// 退出码：0 = 全过；1 = 有 error 级问题（悬空 / 预算硬越界 / 恒注从未命中 / 索引严重失真）；2 = 只有 warn。

import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DSH_HOME } from "./constants.js";
import {
  unitsOf, budgetsOf, limitsOf, budgetOf, resolveUnitPath,
} from "./manifest.js";
import { checkDangling, renderUnit } from "./inject.js";
import { coverage, readState, daysSinceHit, scanStore } from "./store.js";
import { readBuffer } from "./buffer.js";

export const LEVELS = { ok: 0, warn: 2, error: 1 };

/** 1) 悬空引用 */
export function checkDanglingRefs(manifest, opts = {}) {
  const items = [];
  for (const u of unitsOf(manifest)) {
    const r = checkDangling(u, { dshHome: opts.dshHome || DSH_HOME });
    if (!r.ok) items.push({ id: u.id, level: "error", detail: r.detail });
  }
  return { name: "悬空引用", ok: items.length === 0, items, level: items.length ? "error" : "ok" };
}

/**
 * 2) 过期单元（last_hit 太久 / 正文长期未更新 / 从未命中）
 *
 * never-hit 判定（2026-10-25 补，源起：体检发现 34/67 单元从未被投递却判 OK）：
 *  - L1 / anchor 是恒注层，从未命中 = 注入通路坏了 → error；
 *  - L2 是规则层，从未命中 = 触发词覆盖不到实际句子 → warn（列出 id 供加词）；
 *  - L3 是按需层，从未命中属正常（可能真没聊到），不判、只计数。
 */
export function checkStale(manifest, { dshHome = DSH_HOME, statePath, maxDays = 120, hitDays = 60 } = {}) {
  const state = readState(statePath);
  const units = unitsOf(manifest);
  const seenSet = new Set(Object.keys(state?.lastHit || {}));
  const items = [];
  const neverHit = [];
  const today = Date.now();
  for (const u of units) {
    const { absPath } = resolveUnitPath(u, { dshHome });
    if (absPath && existsSync(absPath)) {
      const mtime = statSync(absPath).mtimeMs;
      const age = Math.floor((today - mtime) / 86400000);
      if (age > maxDays) {
        items.push({ id: u.id, level: "warn", detail: `正文 ${age} 天没更新（>${maxDays}）：${absPath}` });
        continue;
      }
    }
    const d = daysSinceHit(u.id, statePath);
    const grace = typeof u.salience === "number" && u.salience >= 8 ? hitDays * 2 : hitDays;
    if (d !== null && d > grace) {
      items.push({ id: u.id, level: "warn", detail: `${d} 天没被命中（宽限 ${grace} 天，salience=${u.salience ?? "-"}）` });
    }
  }
  // 从未命中（有 state 或 turn>0 才算「可判」，首跑全空时留给首跑哨兵）
  const judgeNeverHit = (state?.turn || 0) > 0 || seenSet.size > 0;
  if (judgeNeverHit) {
    for (const u of units) {
      if (seenSet.has(u.id)) continue;
      if (u.layer === "L1" || u.layer === "anchor") {
        items.push({ id: u.id, level: "error", detail: `恒注单元从未命中 —— 注入通路可能坏了（layer=${u.layer}）` });
      } else if (u.layer === "L2") {
        neverHit.push(u.id);
        items.push({ id: u.id, level: "warn", detail: `规则单元从未命中（L2）—— 触发词可能覆盖不到实际句子：${u.title || u.id}` });
      }
    }
  }
  const seen = seenSet.size;
  return {
    name: "过期单元", ok: items.length === 0, items,
    level: items.some((i) => i.level === "error") ? "error" : items.length ? "warn" : "ok",
    note: seen
      ? `已打戳 ${seen} 个单元 · 从未命中 ${units.length - seen} 个（L2 计 warn，L3 按需不判，L1 恒注漏盖即 error）`
      : "尚无命中记录（首跑不判过期）",
    neverHit,
  };
}

/** 3) 预算越界（按 TopN 的最坏情况算，不用「预算之和」误伤） */
/**
 * 3) 预算越界
 *   层预算按 TopN 的最坏情况算（不用「预算之和」误伤）；
 *   2026-10-25 补：excerpt 单元额外算「实际渲染 vs 单条预算」——
 *   最坏估算只看 budget 之和，看不出「某段正文长到挤爆自己的 budget、注入时被静默 clip」。
 *   实测 identity.soul 实际 2007 字符 / 预算 2600，余量 23%；SOUL 再长一点就会静默截断，
 *   而计入层预算的只有 2600 这个上限，永远显示「不越界」。
 */
export function checkBudgets(manifest, { dshHome = DSH_HOME } = {}) {
  const budgets = budgetsOf(manifest);
  const limits = limitsOf(manifest);
  const units = unitsOf(manifest);
  const items = [];
  const excerpts = [];
  const worst = {};
  for (const layer of ["L1", "L2", "L3", "anchor"]) {
    const caps = units.filter((u) => u.layer === layer).map((u) => budgetOf(u)).sort((a, b) => b - a);
    const top = caps.slice(0, limits[layer] || 99);
    const sum = top.reduce((a, b) => a + b, 0);
    const pct = budgets[layer] ? Math.round((sum / budgets[layer]) * 1000) / 10 : 0;
    worst[layer] = { sum, limit: budgets[layer], top: top.length, pct };
    if (sum > budgets[layer]) {
      items.push({ id: layer, level: "error", detail: `最坏注入 ${sum} > 层预算 ${budgets[layer]}（TopN=${limits[layer]}）` });
    } else if (pct >= 95) {
      items.push({ id: layer, level: "warn", detail: `层预算占用 ${pct}%（${sum}/${budgets[layer]}）—— 余量不足 5%，再加一条就爆` });
    }
  }
  // excerpt 实际余量（单条）
  for (const u of units) {
    if (u.mode !== "excerpt") continue;
    const cap = budgetOf(u);
    if (!cap) continue;
    let out;
    try {
      out = renderUnit(u, { dshHome });
    } catch {
      continue;
    }
    const chars = out.chars || 0;
    const pct = Math.round((chars / cap) * 100);
    const cut = /…$/.test(out.text || "");
    excerpts.push({ id: u.id, chars, cap, pct, cut });
    if (cut) {
      items.push({ id: u.id, level: "error", detail: `正文 ${chars}/${cap} 字符，注入时已被截断（收尾是 …）—— 预算不够，删内容或加预算` });
    } else if (pct >= 90) {
      items.push({ id: u.id, level: "warn", detail: `正文 ${chars}/${cap}（${pct}%）—— 余量不足 10%，再长一段就会被静默截断` });
    }
  }
  const layerSum = ["L1", "L2", "L3", "anchor"].reduce((a, k) => a + worst[k].sum, 0);
  if (layerSum > budgets.total) {
    items.push({ id: "total", level: "error", detail: `四层最坏之和 ${layerSum} > total ${budgets.total}` });
  }
  for (const u of units) {
    const b = budgetOf(u);
    if (b > budgets.total) items.push({ id: u.id, level: "error", detail: `单条 ${b} > total ${budgets.total}` });
  }
  return { name: "预算越界", ok: items.length === 0, items, level: items.some((i) => i.level === "error") ? "error" : items.length ? "warn" : "ok", worst, budgets, excerpts };
}

/** 4) 覆盖缺口（豁免单独计数，不进缺口） */
export function checkCoverage(manifest, { dshHome = DSH_HOME, ignore = [] } = {}) {
  const cov = coverage(manifest, { dshHome });
  const items = [];
  const ig = new Set(ignore.map((s) => String(s).replace(/\\/g, "/").toLowerCase()));
  for (const p of cov.missing) items.push({ id: p, level: "error", detail: `清单登记了但文件不在：${p}` });
  for (const p of cov.unregistered) {
    const key = String(p).replace(/\\/g, "/").toLowerCase();
    if (ig.has(key)) continue;
    items.push({ id: p, level: "warn", detail: `知识库里有文件但没登记单元、也没声明豁免：${p}` });
  }
  // 豁免本身要立得住：写错路径（文件不存在）或跟单元重复声明，都算错
  for (const p of cov.invalidExclude) items.push({ id: p, level: "error", detail: `豁免了一个不存在的文件（路径写错）：${p}` });
  for (const p of cov.redundantExclude) items.push({ id: p, level: "error", detail: `豁免了已登记成单元的文件（重复声明）：${p}` });

  const errors = items.filter((i) => i.level === "error").length;
  return {
    name: "覆盖缺口", ok: items.length === 0, items,
    level: errors ? "error" : items.length ? "warn" : "ok",
    registered: cov.registered, scanned: cov.scanned,
    excluded: cov.excluded, excludedTotal: cov.excludedTotal,
  };
}

/**
 * 5) 冲突缓冲（2026-10-25 加，两组分离的配套）：同一 key 反复撞车 → 该归属了。
 * 缓冲本身不是错误；反复撞同一 key 才说明 keys 划得不对。
 *
 * 2026-10-26 检修修入（原判据两处过宽，实测证据见 logs\repair-20261026\C-memory.md）：
 *   ① 按**全历史**累计 → 已收敛的 key 永久报红（当天 11 个 key 里 5 个是 10-25 13:16–18:33 的残留）；
 *   ② 按**事件条数**计数 → 同一次撞车被多个 turn 重复记账，次数虚高（mc 132 条其实只有 2 个配对）。
 *   改为：只统计 windowDays（默认 7）内的事件，并按「winner|loser 配对」去重后计数。
 *   阈值仍是 3 个**唯一配对**才报 warn —— 同一条配对反复撞不重复计数，但也不掩盖。
 */
export function checkConflicts(manifest, { dshHome = DSH_HOME, threshold = 3, windowDays = 7 } = {}) {
  const all = readBuffer(dshHome);
  const cutoff = Date.now() - windowDays * 86400000;
  const parseTs = (s) => {
    const t = Date.parse(String(s || "").replace(" ", "T"));
    return Number.isFinite(t) ? t : null;
  };
  const events = all.filter((e) => {
    const t = parseTs(e.ts);
    return t !== null && t >= cutoff;   // 无时间戳的旧事件不进窗口（它们已无法判定新鲜度）
  });
  const byKey = new Map();
  for (const e of events) {
    const k = String(e.key || "");
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, { key: k, count: 0, pairs: new Set(), losers: new Set(), winners: new Set() });
    const rec = byKey.get(k);
    rec.count++;
    rec.pairs.add(`${e.winner || ""}|${e.loser || ""}`);
    if (e.loser) rec.losers.add(e.loser);
    if (e.winner) rec.winners.add(e.winner);
  }
  const items = [];
  for (const rec of byKey.values()) {
    if (rec.pairs.size >= threshold) {
      items.push({
        id: rec.key,
        level: "warn",
        detail: `key「${rec.key}」近 ${windowDays} 天 ${rec.count} 次 / 去重 ${rec.pairs.size} 对（胜 ${[...rec.winners].join(",")} / 输 ${[...rec.losers].join(",")}）—— 建议归属或改 keys`,
      });
    }
  }
  return {
    name: "冲突缓冲", ok: items.length === 0, items,
    level: items.length ? "warn" : "ok",
    note: all.length
      ? `全历史 ${all.length} 条 · 近 ${windowDays} 天 ${events.length} 条 · 窗口内撞词 key ${byKey.size} 个（去重配对计阈值）`
      : "缓冲为空（无同 key 冲突）",
  };
}

/**
 * 6) 索引事实核对（2026-10-25 加；源起：三处绿灯同时亮着，体系实际坏三处）
 *
 * 悬空引用只查「引用的文件在不在」，查不出「引用的数字对不对」——
 *   INDEX.md 写 handover「54 节」而实际 348 节（偏差 84%）；
 *   会话索引写「65 个会话」而实际 109 个（漏 40%）。
 * 两条都过悬空检查、报告给绿灯，实际早已不能当参考。
 *
 * 只核对两类「可机械核对」的断言，宁窄不宽（避免误报）：
 *   a) 同一行既有 `（N 节）` / `(N 节)` 又有反引号 .md 路径 → 数该文件 `^## ` 标题数
 *   b) 含 `统计：N 个会话` → 与实际 sessions/<ws>/<sid>/ 会话目录数比对
 * 判级：偏差 > 容差 → warn；偏差 ≥ 40% → error（索引已失去参考价值）。
 */
export function checkIndexFacts(manifest, { dshHome = DSH_HOME, tolerance = 8 } = {}) {
  const items = [];
  const checked = [];

  const absOf = (raw) => {
    let s = String(raw).trim().replace(/^~[\\/]\.dsh[\\/]/, "").replace(/^~[\\/]/, "");
    if (/^[A-Za-z]:[\\/]/.test(s)) return s;
    return join(dshHome, s.replace(/\\/g, "/"));
  };
  const countSections = (p) => {
    try {
      const lines = readFileSync(p, "utf8").split(/\r?\n/);
      // handover 的节是 `## 1022) 标题`（编号累加、中间有归档跳号）。
      // 必须认编号格式 —— 裸数 `## ` 会把交接正文里嵌的标题也算进来（实测 754 vs 340）。
      const numbered = lines.filter((l) => /^##\s+\d+\)/.test(l)).length;
      if (numbered > 0) return numbered;
      return lines.filter((l) => /^##\s+\S/.test(l)).length;
    } catch {
      return -1;
    }
  };
  // 一个「会话」= 含 *.zstd 的那个目录（一个会话目录可能有 v3/v4 多个文件）
  const countSessions = (root) => {
    let n = 0;
    const walk = (d) => {
      let ents;
      try {
        ents = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      if (ents.some((e) => !e.isDirectory() && e.name.endsWith(".zstd"))) {
        n++;
        return;
      }
      for (const e of ents) if (e.isDirectory()) walk(join(d, e.name));
    };
    if (!existsSync(root)) return -1;
    walk(root);
    return n;
  };

  // a) 「（N 节）」+ 同行反引号路径
  const indexMd = join(dshHome, "knowledge", "INDEX.md");
  if (existsSync(indexMd)) {
    const lines = readFileSync(indexMd, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = line.match(/[（(](\d+)\s*节[）)]/);
      if (!m) return;
      const claimed = Number(m[1]);
      const paths = [...line.matchAll(/`([^`]+)`/g)]
        .map((x) => x[1])
        .filter((s) => /\.md$/i.test(s.trim()));
      if (!paths.length) return;
      const abs = absOf(paths[0]);
      if (!existsSync(abs)) return; // 文件不在 → 归「悬空引用」那一类
      const actual = countSections(abs);
      if (actual < 0) return;
      checked.push({ file: paths[0], claimed, actual, unit: "节" });
      const diff = Math.abs(claimed - actual);
      if (diff > tolerance) {
        const pct = actual ? Math.round((diff / actual) * 100) : 100;
        items.push({
          id: `INDEX.md:${i + 1}`,
          level: pct >= 40 ? "error" : "warn",
          detail: `声称「${claimed} 节」，实际 ${actual} 节（偏差 ${diff} / ${pct}%）—— ${paths[0]}`,
        });
      }
    });
  }

  // b) 「统计：N 个会话」
  const sessIdx = join(dshHome, "knowledge", "sessions", "index.md");
  if (existsSync(sessIdx)) {
    const txt = readFileSync(sessIdx, "utf8");
    const m = txt.match(/统计：\s*(\d+)\s*个会话/);
    if (m) {
      const claimed = Number(m[1]);
      const actual = countSessions(join(dshHome, "sessions"));
      if (actual >= 0) {
        checked.push({ file: "sessions/index.md", claimed, actual, unit: "会话" });
        const diff = claimed - actual;
        const pct = actual ? Math.abs(diff) / actual : 1;
        if (Math.abs(diff) > tolerance) {
          const lack = Math.max(0, actual - claimed);
          items.push({
            id: "sessions/index.md",
            level: pct >= 0.4 ? "error" : "warn",
            detail: `声称「${claimed} 个会话」，实际 ${actual} 个（${lack ? `索引漏 ${lack} 个 / ` : ""}偏差 ${Math.round(pct * 100)}%）—— 跨会话回忆入口已失真`,
          });
        }
      }
    }
  }

  const errors = items.filter((i) => i.level === "error").length;
  return {
    name: "索引事实", ok: items.length === 0, items,
    level: errors ? "error" : items.length ? "warn" : "ok",
    checked,
    note: checked.length
      ? `核对 ${checked.length} 处数字断言（容差 ±${tolerance}）：${checked.map((c) => `${c.unit} ${c.claimed}→${c.actual}`).join(" · ")}`
      : "无可核对的数字断言（或索引文件缺失）",
  };
}

/**
 * 全量体检。
 * @param {object} manifest
 * @param {object} opts { dshHome, statePath, ignore, asText }
 */
export function checkup(manifest, opts = {}) {
  const checks = [
    checkDanglingRefs(manifest, opts),
    checkStale(manifest, opts),
    checkBudgets(manifest, opts),
    checkCoverage(manifest, opts),
    checkConflicts(manifest, opts),
    checkIndexFacts(manifest, opts),
  ];
  let code = 0;
  for (const c of checks) {
    if (c.level === "error") code = 1;
    else if (c.level === "warn" && code === 0) code = 2;
  }
  const units = unitsOf(manifest);
  const report = {
    ok: code === 0,
    code,
    at: new Date().toISOString(),
    units: units.length,
    checks,
    summary: checks.map((c) => `${c.name}: ${c.ok ? "ok" : `${c.items.length} 项（${c.level}）`}`).join(" | "),
  };
  if (opts.asText) report.text = formatReport(report);
  return report;
}

/** 人读报告（CLI / 工具 output 共用）。 */
export function formatReport(r) {
  const out = [];
  out.push(`ctx-manifest 体检 · ${r.at}`);
  out.push(`单元 ${r.units} 条 · 结论 ${r.code === 0 ? "全过" : r.code === 1 ? "有 error" : "仅 warn"}`);
  out.push("");
  for (const c of r.checks) {
    out.push(`[${c.ok ? "OK  " : c.level.toUpperCase()}] ${c.name}${c.items.length ? `（${c.items.length}）` : ""}`);
    if (c.name === "预算越界" && c.worst) {
      for (const [k, v] of Object.entries(c.worst)) {
        out.push(`      ${k}: 最坏 ${v.sum} / 预算 ${v.limit}（TopN=${v.top}${v.pct !== undefined ? ` · 占用 ${v.pct}%` : ""}）`);
      }
      for (const e of c.excerpts || []) {
        out.push(`      实际 excerpt · ${e.id}: ${e.chars}/${e.cap}（${e.pct}%${e.cut ? " · 已截断" : " · 未截断"}）`);
      }
    }
    if (c.name === "覆盖缺口") {
      out.push(`      登记 ${c.registered} 个文件 / 扫到 ${c.scanned} 个 / 豁免 ${c.excludedTotal || 0} 条（命中 ${c.excluded || 0}）`);
    }
    if (c.note) out.push(`      ${c.note}`);
    for (const it of c.items.slice(0, 12)) out.push(`      - ${it.id}: ${it.detail}`);
    if (c.items.length > 12) out.push(`      … 还有 ${c.items.length - 12} 项`);
  }
  return out.join("\n");
}

export { scanStore };
