// lib/buffer.js —— 两组分离 + 冲突缓冲（零外部 import）
//
// 两组（2026-10-25 用户定：规则组 / 知识组）
//   core       L1 恒注 + anchor：永远保留，不参与仲裁
//   rule       id 以 rule. / std. / governance. 开头：怎么干活（约束）
//   knowledge  其余 L3 单元：记得什么（内容）
//
// 冲突判定：同一轮里同一个 key 命中多个单元。
// 仲裁规则（确定性，不随机）：
//   1) core 永远保留；
//   2) 跨组 rule vs knowledge → rule 赢（约束优先于内容）；
//   3) 同组 → score 降序，平手取 id 字典序小者；
//   4) 输掉的单元本轮不注入，写 conflict-buffer.jsonl 留档，供 checkup 与人工归属。
//      （不丢信息：下一轮若它单独命中且不冲突，照常投递。）
//
// 设计取舍：缓冲只作用于「同一轮同 key 多命中」，不做跨轮延迟投递 ——
// 延迟会让注入变成非确定状态，排查成本远高于收益。

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DSH_HOME } from "./constants.js";

export const GROUPS = ["core", "rule", "knowledge"];

/** 单元归属哪个组。 */
export function groupOf(unit) {
  if (!unit) return "knowledge";
  const id = String(unit.id || "");
  if (unit.layer === "L1" || unit.layer === "anchor") return "core";
  if (/^(rule|std|governance)\./.test(id)) return "rule";
  return "knowledge";
}

/** 组优先级：core 最高，rule 次之，knowledge 最后。 */
function groupRank(g) {
  return g === "core" ? 0 : g === "rule" ? 1 : 2;
}

/**
 * 冲突仲裁。输入是 router.select 的产出（每条带 hits 数组）。
 * @returns {{ kept: Array, buffered: Array<{key,winner,loser,why}> }}
 */
export function detectConflicts(picked = []) {
  const byKey = new Map();

  for (const u of picked) {
    const hits = Array.isArray(u.hits) ? u.hits : [];
    for (const raw of hits) {
      const key = String(raw || "").trim();
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      const arr = byKey.get(key);
      if (!arr.some((x) => x.id === u.id)) arr.push(u);
    }
  }

  // 2026-10-25 修正：按「单元的全部命中 key」判缓冲，不是「任一 key 输就整单元缓冲」。
  // 反例（修前实测）：junction 单元的「升级」撞上 rule.env.E3 被整条缓冲，
  // 导致「junction 升级后失效」一个字都查不到 —— 而「junction」本是它独占的地盘。
  const lost = new Map(); // id -> Set(key)  输掉的 key
  const won = new Map();  // id -> Set(key)  赢的 / 独占的 key
  const winnerByKey = new Map();
  const add = (map, id, key) => {
    if (!map.has(id)) map.set(id, new Set());
    map.get(id).add(key);
  };

  for (const [key, arr] of byKey) {
    if (arr.length < 2) {
      for (const u of arr) add(won, u.id, key); // 独占 = 赢
      continue;
    }
    const sorted = [...arr].sort((a, b) => {
      const ga = groupRank(groupOf(a));
      const gb = groupRank(groupOf(b));
      if (ga !== gb) return ga - gb;
      const sa = typeof a.score === "number" ? a.score : 0;
      const sb = typeof b.score === "number" ? b.score : 0;
      if (sb !== sa) return sb - sa;
      return String(a.id).localeCompare(String(b.id));
    });
    const winner = sorted[0];
    winnerByKey.set(key, winner.id);
    add(won, winner.id, key);
    for (const loser of sorted.slice(1)) {
      if (groupOf(winner) === "core") continue; // core 恒注优先，不记冲突
      add(lost, loser.id, key);
    }
  }

  const buffered = [];
  const kept = [];
  for (const u of picked) {
    const lostKeys = lost.get(u.id);
    const wonKeys = won.get(u.id);
    const hasLost = lostKeys && lostKeys.size > 0;
    const hasWin = wonKeys && wonKeys.size > 0;
    if (hasLost && !hasWin) {
      const key = [...lostKeys][0];
      buffered.push({
        key, winner: winnerByKey.get(key) || "", loser: u.id,
        why: `所有命中 key 都被占（${[...lostKeys].join(",")}）`,
      });
    } else {
      kept.push(u);
    }
  }
  return { kept, buffered };
}

/** 冲突缓冲文件路径。 */
export function bufferPath(dshHome = DSH_HOME) {
  return join(dshHome, "routing", "conflict-buffer.jsonl");
}

/** 追加缓冲事件（JSONL，每行一条）。 */
export function writeBuffer(events, { ts, turn, dshHome = DSH_HOME } = {}) {
  if (!events || !events.length) return null;
  const abs = bufferPath(dshHome);
  try {
    mkdirSync(dirname(abs), { recursive: true });
    const lines = events.map((e) =>
      JSON.stringify({ ts, turn: turn || 0, key: e.key, winner: e.winner, loser: e.loser, why: e.why })
    );
    appendFileSync(abs, lines.join("\n") + "\n", "utf8");
    return abs;
  } catch {
    return null;
  }
}

/** 读缓冲（供 checkup / CLI；缺文件返回空数组）。 */
export function readBuffer(dshHome = DSH_HOME) {
  const abs = bufferPath(dshHome);
  if (!existsSync(abs)) return [];
  try {
    const text = readFileSync(abs, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export { groupRank };
