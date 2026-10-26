#!/usr/bin/env node
// scripts/gate.mjs —— 发布门（Gate 第②条的可执行版本）
//
// 查两类东西：
//   ① 绝对路径：Windows 用户目录 / macOS 用户目录 / 带具体项目名的家目录 —— 换台机器就失效，还可能泄露用户名
//   ② 私人词：从**仓库外**的名单文件读（默认 ../_private-names.txt），一行一个
//
// 为什么要外部名单：敏感词本身不能写进仓库，否则检查脚本自己就成了泄露源。
//
// 用法：
//   node scripts/gate.mjs                        # 用默认名单（存在才查）
//   node scripts/gate.mjs --names ../names.txt
//   node scripts/gate.mjs --json

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const root = resolve(argOf("root", join(here, "..")));
const namesFile = resolve(argOf("names", join(root, "..", "_private-names.txt")));
const asJson = argv.includes("--json");

const SKIP = /(^|\\)(\.git|node_modules|_raw|\.demo-trace)($|\\)/i;
const TEXT = new Set([".js", ".mjs", ".cjs", ".ts", ".json", ".md", ".yml", ".yaml", ".ps1", ".txt", ".html", ".css"]);

let names = [];
try {
  names = readFileSync(namesFile, "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
} catch { /* 没有名单文件就只查路径 */ }

const PATH_PATTERNS = [
  /[A-Za-z]:\\Users\\[^\s"'`]+/g,
  /\/Users\/[a-z0-9._-]+\//gi,
];

function walk(dir, out = []) {
  let list = [];
  try { list = readdirSync(dir); } catch { return out; }
  for (const name of list) {
    const p = join(dir, name);
    if (SKIP.test(p)) continue;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (TEXT.has(extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

const files = walk(root);
const hits = [];
for (const f of files) {
  let text = "";
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  const rel = f.slice(root.length + 1);
  for (const re of PATH_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ file: rel, kind: "path", sample: m[0].slice(0, 60) });
  }
  for (const w of names) {
    if (w && text.includes(w)) hits.push({ file: rel, kind: "name", sample: w });
  }
}

const result = {
  id: "gate",
  level: hits.length ? "error" : "ok",
  detail: hits.length
    ? `${hits.length} 处可疑内容（${new Set(hits.map((h) => h.file)).size} 个文件）`
    : `扫描 ${files.length} 个文本文件，${names.length} 个私人词，0 处命中`,
  scanned: files.length,
  namesLoaded: names.length,
  hits,
};
if (asJson) console.log(JSON.stringify(result, null, 2));
else console.log(result.detail + (hits.length ? "\n" + hits.slice(0, 10).map((h) => `  ${h.file}  [${h.kind}]  ${h.sample}`).join("\n") : ""));
process.exit(hits.length ? 1 : 0);
