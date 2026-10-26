// src/adapter/standalone.js —— 无宿主适配器（demo / CI / 命令行）
//
// 契约实现：
//   getTurnText()     取 argv[2] 或 stdin 的一行
//   applyContext(t)   把装配结果写到 stdout（不发就空串）
//   log(line)         写 stderr（stdout 只留给结果，方便管道与快照比对）

import { readFileSync } from "node:fs";

export function createStandaloneAdapter({ text = null, quiet = false } = {}) {
  let captured = "";
  return {
    getTurnText() {
      if (text !== null) return text;
      try {
        return readFileSync(0, "utf8").trim();   // fd 0 = stdin
      } catch {
        return "";
      }
    },
    applyContext(rendered) {
      captured = rendered || "";
      if (!quiet) process.stdout.write(captured);
      return captured;
    },
    log(line) {
      if (!quiet) process.stderr.write(String(line) + "\n");
    },
    /** demo 里取最近一次渲染结果 */
    lastRendered() {
      return captured;
    },
  };
}
