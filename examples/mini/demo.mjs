// examples/mini/demo.mjs —— 无宿主 demo：一句话进，注入文本 + 理由出
//
// 用法：
//   node examples/mini/demo.mjs                      # 用内置例句
//   node examples/mini/demo.mjs "改文件前要做什么"     # 自己给一句
//   node examples/mini/demo.mjs --json "..."          # 机读
//
// 判据（计划书 §4.1）：在没有 DSH 的目录里跑这个，能出命中结果与 trace。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createEngine } from "../../src/bootstrap.js";
import { createStandaloneAdapter } from "../../src/adapter/standalone.js";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const text = argv.filter((a) => !a.startsWith("--")).join(" ") || "改文件之前要做什么";

const adapter = createStandaloneAdapter({ text, quiet: true });   // quiet：不让 adapter 直接写 stdout，由本文件统一排版
const engine = createEngine({
  adapter,
  manifestPath: join(here, "manifest.json"),
  config: {
    mode: "clause",
    trace: true,
    tracePath: join(here, "..", "..", ".demo-trace", "inject-trace.jsonl"),
    home: here,
  },
});

const res = engine.turn();
const units = (res.units || []).map((u) => ({ id: u.id, layer: u.layer, mode: u.mode, score: u.score, reason: u.reason }));

if (asJson) {
  console.log(JSON.stringify({ input: text, chars: res.chars || 0, budgetLeft: res.budgetLeft, units, text: adapter.lastRendered() }, null, 2));
} else {
  console.log(`> ${text}`);
  console.log("");
  console.log(`命中 ${units.length} 个单元 · ${res.chars || 0} 字符 · 余量 ${res.budgetLeft ?? "-"}`);
  for (const u of units) console.log(`  · ${u.id}  [${u.layer}/${u.mode}]  score=${u.score}  ${u.reason}`);
  if (!units.length) console.log("  （无命中 —— 闲聊不注，这是设计）");
  const rendered = adapter.lastRendered();
  if (rendered) {
    const lines = rendered.split("\n");
    console.log("");
    console.log("---- 实际注入（前 24 行）----");
    console.log(lines.slice(0, 24).join("\n"));
    if (lines.length > 24) console.log(`…（共 ${lines.length} 行，完整内容见 .demo-trace/ 或直接读 corpus）`);
  }
  const ck = engine.checkup();
  console.log("");
  console.log(`体检：${ck.ok ? "OK" : "有问题"}`);
  for (const c of ck.checks || []) {
    const mark = c.ok ? "✓" : "✗";
    const note = c.note ? `  ${c.note}` : "";
    console.log(`  ${mark} ${c.name}${note}`);
  }
}
