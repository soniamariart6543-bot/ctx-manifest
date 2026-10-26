#!/usr/bin/env node
// checks/bom.mjs —— 运维检查①：非 ASCII 的脚本必须有 BOM
//
// 为什么抽这一条：Windows PowerShell 5.1 读无 BOM 的 UTF-8 文件会按 ANSI 解码，
// 中文注释直接变乱码，甚至会改变脚本行为。这是**跨机器成立**的规矩，所以进开源包。
//
// 契约：{ id, level, detail }，level ∈ ok | warn | error。输出 JSON，可被 CI / jq 消费。
// 用法：
//   node checks/bom.mjs --dir .
//   node checks/bom.mjs --dir . --json

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const root = resolve(argOf("dir", "."));
const SKIP = /node_modules|\.git|_raw|\.demo-trace/;
const EXT = new Set([".ps1", ".psm1"]);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function walk(dir, out = []) {
  let list = [];
  try { list = readdirSync(dir); } catch { return out; }
  for (const name of list) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP.test(p)) continue;
      walk(p, out);
    } else if (EXT.has(extname(name).toLowerCase())) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(root);
const missing = [];
const nonAscii = [];
for (const f of files) {
  const buf = readFileSync(f);
  const hasBom = buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2];
  const body = hasBom ? buf.subarray(3) : buf;
  let ascii = true;
  for (const b of body) { if (b > 127) { ascii = false; break; } }
  if (!ascii) nonAscii.push(f);
  if (!ascii && !hasBom) missing.push(f);
}

const result = {
  id: "bom",
  level: missing.length ? "error" : "ok",
  detail: missing.length
    ? `${missing.length} 个非 ASCII 脚本缺 BOM：${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " …" : ""}`
    : `扫描 ${files.length} 个 PowerShell 文件，${nonAscii.length} 个含非 ASCII，全部有 BOM`,
  scanned: files.length,
  nonAscii: nonAscii.length,
  missing,
};
console.log(JSON.stringify(result, null, 2));
process.exit(missing.length ? 1 : 0);
