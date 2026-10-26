#!/usr/bin/env node
// scripts/keys-clean.mjs —— 键卫生：找出「碎片键」（n-gram 滑窗切出来的残片）
//
// 判据（可复跑，不靠肉眼）：key 是同一单元另一个更长 key 的严格子串，**且切在词中间**
// （既不是前缀也不是后缀）→ 碎片。例：「程备」⊂「工程备忘」中间。
// 合法的前缀/后缀不算碎片：「备份」⊂「先备份」后缀、「BOM」⊂「BOM 复检」前缀。
//
// 用法：
//   node scripts/keys-clean.mjs --manifest examples/mini/manifest.json        # 只报
//   node scripts/keys-clean.mjs --manifest ... --apply                        # 真删（会先备份）
//   node scripts/keys-clean.mjs --manifest ... --json

import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const manifestPath = resolve(argOf("manifest", "examples/mini/manifest.json"));
const apply = argv.includes("--apply");
const asJson = argv.includes("--json");

const tree = JSON.parse(readFileSync(manifestPath, "utf8"));
const units = tree.units || [];
const fragments = [];

for (const u of units) {
  const keys = Array.isArray(u.keys) ? u.keys : [];
  const low = keys.map((k) => String(k).toLowerCase());
  const seen = new Set();
  for (let i = 0; i < keys.length; i++) {
    for (let j = 0; j < keys.length; j++) {
      if (i === j) continue;
      const a = low[i];
      const b = low[j];
      if (!a || !b || a.length >= b.length) continue;
      const pos = b.indexOf(a);
      if (pos <= 0) continue;                       // 不是子串，或恰好是前缀（合法）
      if (pos + a.length >= b.length) continue;     // 恰好是后缀（合法）
      if (seen.has(keys[i])) continue;
      seen.add(keys[i]);
      fragments.push({ unit: u.id, key: keys[i], inside: keys[j] });
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ manifest: manifestPath, fragments, count: fragments.length }, null, 2));
} else {
  console.log(`清单：${manifestPath}`);
  console.log(`碎片键 ${fragments.length} 处（${new Set(fragments.map((f) => f.unit)).size} 个单元）`);
  for (const f of fragments) console.log(`  ${f.unit}: 「${f.key}」⊂「${f.inside}」`);
}

if (apply && fragments.length) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bak = join(dirname(manifestPath), `.bak-keys-clean-${ts}.json`);
  mkdirSync(dirname(bak), { recursive: true });
  copyFileSync(manifestPath, bak);
  for (const f of fragments) {
    const u = units.find((x) => x.id === f.unit);
    if (u) u.keys = u.keys.filter((k) => k !== f.key);
  }
  writeFileSync(manifestPath, JSON.stringify(tree, null, 2) + "\n", "utf8");
  console.log(`\n已删 ${fragments.length} 个碎片键；备份：${bak}`);
}

if (!apply) console.log("\n（只报不改；加 --apply 才会删，删前自动备份）");
process.exit(fragments.length ? 1 : 0);
