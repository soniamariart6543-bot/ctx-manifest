#!/usr/bin/env node
// checks/manifest-checkup.mjs —— 运维检查②：清单六类体检（悬空 / 过期 / 预算 / 覆盖 / 冲突 / 索引事实）
//
// 它不重复实现逻辑，只是把 src/checkup.js 的结果压成 { id, level, detail } 契约，方便 CI 与 jq。
// 用法：
//   node checks/manifest-checkup.mjs --manifest examples/mini/manifest.json
//   node checks/manifest-checkup.mjs --manifest ... --json

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadManifest } from "../src/manifest.js";
import { checkup } from "../src/checkup.js";

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const manifestPath = resolve(argOf("manifest", "examples/mini/manifest.json"));

const loaded = loadManifest(manifestPath, { force: true });
if (!loaded.ok) {
  console.log(JSON.stringify({ id: "manifest-checkup", level: "error", detail: `清单加载失败：${manifestPath}`, errors: loaded.errors?.slice(0, 5) }, null, 2));
  process.exit(1);
}
const manifest = loaded.manifest || loaded;
const baseDir = dirname(manifestPath);
const res = checkup(manifest, { dshHome: baseDir });

const failing = (res.checks || []).filter((c) => !c.ok);
const result = {
  id: "manifest-checkup",
  level: failing.some((c) => c.level === "error") ? "error" : failing.length ? "warn" : "ok",
  detail: failing.length
    ? `${failing.length} 类检查未通过：${failing.map((c) => c.name).join("、")}`
    : `六类检查全部通过（${(res.checks || []).length} 项）`,
  units: (manifest.units || []).length,
  checks: (res.checks || []).map((c) => ({ name: c.name, ok: c.ok, level: c.level, note: c.note || "" })),
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.level === "ok" ? 0 : 1);
