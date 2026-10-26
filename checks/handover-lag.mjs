#!/usr/bin/env node
// checks/handover-lag.mjs —— 运维检查③：交接文件是否在「还在改东西」的时候停滞了
//
// 为什么这条进开源包：跨会话状态存在文件里，最危险的失败不是写错，是**没写**。
// 判据：交接文件的修改时间落后于「最近一次代码改动」超过 N 天 → warn。
// 这是换谁都成立的检查，不依赖具体目录名（路径可配）。
//
// 用法：
//   node checks/handover-lag.mjs --handover docs/HANDOVER.md --watch src --max-days 3
//   node checks/handover-lag.mjs --handover ... --json

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const handover = resolve(argOf("handover", "docs/HANDOVER.md"));
const watch = resolve(argOf("watch", "src"));
const maxDays = Number(argOf("max-days", "3")) || 3;

function newest(dir, skip = /node_modules|\.git/) {
  let best = 0;
  let list = [];
  try { list = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of list) {
    const p = join(dir, e.name);
    if (skip.test(p)) continue;
    try {
      if (e.isDirectory()) best = Math.max(best, newest(p, skip));
      else best = Math.max(best, statSync(p).mtimeMs);
    } catch { /* 跳过不可读项 */ }
  }
  return best;
}

const hMs = (() => { try { return statSync(handover).mtimeMs; } catch { return 0; } })();
const codeMs = newest(watch);
const day = 864e5;
const lagDays = hMs && codeMs ? +((codeMs - hMs) / day).toFixed(1) : null;

let level = "ok";
let detail;
if (!hMs) {
  level = "error";
  detail = `交接文件不存在或不可读：${handover}`;
} else if (lagDays === null) {
  level = "warn";
  detail = `看不出最近改动（监视目录为空：${watch}）`;
} else if (lagDays > maxDays) {
  level = "warn";
  detail = `交接落后代码改动 ${lagDays} 天（阈值 ${maxDays}）—— 换会话会接不上`;
} else {
  detail = `交接与代码同步（落后 ${lagDays} 天，阈值 ${maxDays}）`;
}

console.log(JSON.stringify({ id: "handover-lag", level, detail, handover, watch, lagDays, maxDays }, null, 2));
process.exit(level === "ok" ? 0 : 1);
