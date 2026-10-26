#!/usr/bin/env node
// scripts/trace-stats.mjs —— 注入趋势（尺子的另一半）
//
// 回答三个问题：
//   ① 这一轮注入了什么、为什么   → units / reasons / by_layer
//   ② 这周比上周好了还是差了     → 按天趋势 + 恒注字符漂移
//   ③ 有没有静默失效             → 空转率 / clipped / dangling
//
// 用法：
//   node scripts/trace-stats.mjs --trace .demo-trace/inject-trace.jsonl --days 7
//   node scripts/trace-stats.mjs --trace ... --json

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const tracePath = argOf("trace", ".demo-trace/inject-trace.jsonl");
const days = Number(argOf("days", "7")) || 7;
const asJson = argv.includes("--json");

let raw = "";
try {
  raw = readFileSync(tracePath, "utf8");
} catch {
  console.error(`[trace-stats] 读不到 trace：${tracePath}（先跑一次 demo 生成）`);
  process.exit(2);
}

const cut = Date.now() - days * 864e5;
const rows = [];
for (const line of raw.split("\n")) {
  if (!line.trim()) continue;
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  const t = Date.parse(String(r.ts || "").replace(" ", "T"));
  if (!Number.isFinite(t) || t < cut) continue;
  rows.push({ ...r, _d: String(r.ts).slice(0, 10) });
}

const num = (a) => a.reduce((x, y) => x + y, 0);
const avg = (a) => (a.length ? Math.round(num(a) / a.length) : 0);
const byDay = new Map();
for (const r of rows) {
  if (!byDay.has(r._d)) byDay.set(r._d, []);
  byDay.get(r._d).push(r);
}

const alwaysIds = new Set(["identity.tone", "contract.output"]);   // 示例清单里的恒注单元（可按需改）
const empty = rows.filter((r) => (r.units || []).filter((id) => !alwaysIds.has(id)).length === 0);

const stats = {
  trace: tracePath,
  days,
  turns: rows.length,
  charsAvg: avg(rows.map((r) => r.chars || 0)),
  l1Avg: avg(rows.map((r) => (r.by_layer || {}).L1 || 0)),
  l2Avg: avg(rows.map((r) => (r.by_layer || {}).L2 || 0)),
  l3Avg: avg(rows.map((r) => (r.by_layer || {}).L3 || 0)),
  anchorAvg: avg(rows.map((r) => (r.by_layer || {}).anchor || 0)),
  emptyTurns: empty.length,
  emptyRate: rows.length ? +(empty.length / rows.length * 100).toFixed(1) : 0,
  buffered: num(rows.map((r) => r.buffered || 0)),
  clipped: num(rows.map((r) => r.clipped || 0)),
  dangling: num(rows.map((r) => (r.dangling || []).length)),
  perDay: Object.fromEntries([...byDay].sort().map(([d, list]) => [d, {
    turns: list.length,
    chars: avg(list.map((r) => r.chars || 0)),
    empty: list.filter((r) => (r.units || []).filter((id) => !alwaysIds.has(id)).length === 0).length,
  }])),
};

if (asJson) {
  console.log(JSON.stringify(stats, null, 2));
} else {
  console.log(`近 ${days} 天 · ${stats.turns} 轮 · 平均 ${stats.charsAvg} 字符`);
  console.log(`分层均值：L1 ${stats.l1Avg} / L2 ${stats.l2Avg} / L3 ${stats.l3Avg} / anchor ${stats.anchorAvg}`);
  console.log(`条件层空转 ${stats.emptyTurns} 轮（${stats.emptyRate}%）· buffered ${stats.buffered} · clipped ${stats.clipped} · dangling ${stats.dangling}`);
  for (const [d, v] of Object.entries(stats.perDay)) console.log(`  ${d}  轮 ${v.turns}  字符 ${v.chars}  空转 ${v.empty}`);
}
process.exit(0);
