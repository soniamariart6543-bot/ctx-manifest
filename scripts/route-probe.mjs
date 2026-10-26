#!/usr/bin/env node
// scripts/route-probe.mjs —— 路由回归集（尺子）
//
// 回答一个问题：**改了 keys 之后，召回掉了没有。**
// 它不需要宿主：只加载清单 + 跑 route()，所以能进 CI。
//
// 用法：
//   node scripts/route-probe.mjs                                   # 默认清单与用例
//   node scripts/route-probe.mjs --manifest path/to/manifest.json
//   node scripts/route-probe.mjs --cases path/to/cases.json --json
//
// 判据（退出码 0 才算过）：
//   1) 红线句 4/4 —— 不看平均分，漏一句就是不过
//   2) 改写召回 ≥ 8/10 —— 同一个意思换种说法还得命中
//   3) leak = 0 —— 闲聊不得命中非恒注单元

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "../src/manifest.js";
import { route } from "../src/router.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const asJson = argv.includes("--json");

const manifestPath = resolve(argOf("manifest", join(root, "examples/mini/manifest.json")));
const casesPath = resolve(argOf("cases", join(here, "probe-cases.json")));

const loaded = loadManifest(manifestPath, { force: true });
if (!loaded.ok) {
  console.error(`[probe] 清单校验失败：${manifestPath}`);
  for (const e of (loaded.errors || []).slice(0, 5)) console.error("  " + JSON.stringify(e));
  process.exit(2);
}
const manifest = loaded.manifest || loaded;
const baseDir = dirname(manifestPath);
const cases = JSON.parse(readFileSync(casesPath, "utf8"));

function hits(text) {
  const r = route(text, { manifest, trace: false, baseDir, dshHome: baseDir });
  // 恒注层（always）不算「命中」，否则每条闲聊都算命中
  const always = new Set((manifest.units || []).filter((u) => u.when === "always").map((u) => u.id));
  return { all: r.units.map((u) => u.id), conditional: r.units.filter((u) => !always.has(u.id)).map((u) => u.id) };
}

function judge(list) {
  return (list || []).map(([text, expect]) => {
    const got = hits(text);
    const want = expect || [];
    const missing = want.filter((id) => !got.all.includes(id));
    return { text, expect: want, got: got.all, missing, ok: missing.length === 0 };
  });
}

const redline = judge(cases.redline);
const real = judge(cases.real);
const paraphrase = judge(cases.paraphrase);
const chat = (cases.chat || []).map(([text]) => {
  const got = hits(text);
  return { text, got: got.conditional, ok: got.conditional.length === 0 };
});

const redOk = redline.filter((r) => r.ok).length;
const paraOk = paraphrase.filter((r) => r.ok).length;
const realOk = real.filter((r) => r.ok).length;
const leak = chat.reduce((n, r) => n + r.got.length, 0);
const pass = redOk === redline.length && paraOk >= 8 && leak === 0;

if (asJson) {
  console.log(JSON.stringify({
    manifest: manifestPath,
    redline: `${redOk}/${redline.length}`,
    real: `${realOk}/${real.length}`,
    paraphrase: `${paraOk}/${paraphrase.length}`,
    leak,
    pass,
    detail: { redline, real, paraphrase, chat },
  }, null, 2));
} else {
  const fails = (rows) => rows.filter((r) => !r.ok).map((r) => `${r.text}→缺${r.missing.join(",")}`).join("; ");
  console.log(`清单：${manifestPath}`);
  console.log(`recall(real)        ${realOk}/${real.length}${realOk < real.length ? "  ← " + fails(real) : ""}`);
  console.log(`recall(paraphrase)  ${paraOk}/${paraphrase.length}${paraOk < paraphrase.length ? "  ← " + fails(paraphrase) : ""}`);
  console.log(`redline             ${redOk}/${redline.length}${redOk < redline.length ? "  ← " + fails(redline) : ""}`);
  console.log(`leak                ${leak}${leak ? "  ← " + chat.filter((r) => r.got.length).map((r) => r.text + "→" + r.got.join(",")).join("; ") : ""}`);
  console.log(pass ? "结论：PASS" : "结论：FAIL");
}
process.exit(pass ? 0 : 1);
