#!/usr/bin/env node
// scripts/skill-doctor.mjs —— 技能池体检（八条判据，每条都能复跑）
//
// 技能是「渐进披露」的载体：元数据决定该不该用，正文决定怎么用。
// 所以体检只看两件事：**能不能被选中**、**读到之后有没有用**。
//
// 用法：
//   node scripts/skill-doctor.mjs --dir skills
//   node scripts/skill-doctor.mjs --dir skills --json
//
// 判据：
//   1) 有 frontmatter（--- 包起来的 name/description）
//   2) name 与目录名一致
//   3) description 里有触发语（「当…时使用」这类）
//   4) 正文有 ≥2 个二级标题（可扫读）
//   5) 正文里有可复跑命令（``` 代码块或 `node …`）
//   6) 体量适中（≤ 300 行；> 500 行建议拆文件）
//   7) 目录里不只有 SKILL.md（有配套文件或脚本更好，但不是硬性）
//   8) 不含个人路径 / 私有字样（粗筛）

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const dir = resolve(argOf("dir", "skills"));
const asJson = argv.includes("--json");

let entries = [];
try {
  entries = readdirSync(dir).filter((n) => {
    try { return statSync(join(dir, n)).isDirectory(); } catch { return false; }
  });
} catch {
  console.error(`[doctor] 目录不存在：${dir}`);
  process.exit(2);
}

const rows = [];
for (const name of entries) {
  const file = join(dir, name, "SKILL.md");
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { rows.push({ name, ok: false, issues: ["缺 SKILL.md"], lines: 0, score: 0 }); continue; }
  const lines = text.split("\n").length;
  const issues = [];

  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) issues.push("没有 frontmatter");
  const meta = fm ? fm[1] : "";
  const nameInFm = /^name:\s*(.+)$/m.exec(meta)?.[1]?.trim();
  if (nameInFm && nameInFm !== name) issues.push(`name 与目录名不一致（${nameInFm}）`);
  const descInFm = /^description:\s*([\s\S]*?)$/m.exec(meta)?.[1]?.trim() || "";
  if (!descInFm) issues.push("description 缺失");
  else if (!/当|时使用|用于|Use when/i.test(descInFm)) issues.push("description 里没有触发语");

  const h2 = (text.match(/^##\s+/gm) || []).length;
  if (h2 < 2) issues.push(`二级标题只有 ${h2} 个`);

  if (!/```|\bnode\s|powershell|npm\s/.test(text)) issues.push("正文里没有可复跑命令");

  if (lines > 500) issues.push(`体量 ${lines} 行（>500，建议拆文件）`);
  else if (lines > 300) issues.push(`体量 ${lines} 行（>300，偏长）`);

  let mates = [];
  try { mates = readdirSync(join(dir, name)).filter((f) => f !== "SKILL.md"); } catch { /* ignore */ }
  if (!mates.length) issues.push("目录里只有 SKILL.md（可选改进）");

  if (/[A-Za-z]:\\\\Users|C:\\\\Users|\/Users\//.test(text)) issues.push("正文里出现个人绝对路径");

  const hard = issues.filter((i) => !i.includes("可选改进"));
  rows.push({ name, ok: hard.length === 0, issues, lines, h2, mates: mates.length });
}

const bad = rows.filter((r) => !r.ok).length;

if (asJson) {
  console.log(JSON.stringify({ dir, skills: rows.length, bad, rows }, null, 2));
} else {
  console.log(`技能 ${rows.length} 个 · 有问题 ${bad} 个（${dir}）`);
  for (const r of rows) {
    const mark = r.ok ? "✓" : "✗";
    console.log(`  ${mark} ${r.name.padEnd(28)} ${String(r.lines).padStart(4)} 行  ${r.ok ? "" : r.issues.join("；")}`);
  }
  const avg = rows.length ? rows.reduce((n, r) => n + (r.ok ? 100 : 60), 0) / rows.length : 0;
  console.log(`均分 ${avg.toFixed(0)} / 100`);
}
process.exit(bad ? 1 : 0);
