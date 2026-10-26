// src/adapter/dsh.js —— DSH 宿主适配器（宿主差异全部关在这一个文件里）
//
// 本文件是**唯一**允许知道 DSH 事件格式与 ctx API 的地方。换宿主 = 另写一个同契约文件，
// src/ 其余文件一行不改。
//
// 契约实现：
//   getTurnText()    从 session 事件流取最后一条 source.kind=user 的 user/message
//   applyContext(t)  存下本轮渲染结果（真正交回宿主由 mount() 注册的贡献函数完成）
//   registerSkill(s) 暴露成宿主技能（ctx.skills.register）
//   log(line)        写 console.warn（宿主日志）
//
// 关于 getTurnText 的取证结论（2026-10-21 实测，写在这里免得后人再踩）：
//   systemPrompt.context 的 text 回调只拿到 { agent, scope, signal } —— 没有 messages / input。
//   只盯 assembly 字段会永远拿到空串，于是注入与 trace 全部静默失效。
//   可靠路径是 context.agent.session 的事件流。

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createEngine } from "../bootstrap.js";
import { unitsOf } from "../manifest.js";
import { checkIndex } from "../indexer.js";
import { readState, today } from "../store.js";

/** 会话事件兼容层：不同内核版本分别提供 events / snapshotEvents / ownEvents / eventsSnapshot。 */
export function sessionEvents(session) {
  if (Array.isArray(session?.events)) return session.events;
  for (const fn of ["snapshotEvents", "ownEvents"]) {
    try {
      const v = typeof session?.[fn] === "function" ? session[fn]() : null;
      if (Array.isArray(v)) return v;
    } catch { /* 继续试下一种 */ }
  }
  try {
    if (Array.isArray(session?.eventsSnapshot)) return session.eventsSnapshot;
  } catch { /* ignore */ }
  return [];
}

/** 从消息体里抽纯文本（content 数组只取 type=text）。 */
export function textOfMessage(outer) {
  if (typeof outer === "string") return outer;
  const message = outer?.message ?? outer;
  if (typeof message === "string") return message;
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

/** 取「本轮用户说了什么」。 */
export function extractTurnText(context) {
  const events = sessionEvents(context?.agent?.session);
  let latest = "";
  for (const event of events) {
    if (event?.type !== "user/message") continue;
    const outer = event.data;
    const source = outer?.source ?? outer?.message?.source;
    if (source?.kind && source.kind !== "user") continue;
    const text = String(textOfMessage(outer) || "").trim();
    if (text) latest = text;
  }
  if (latest) return latest;

  // 兜底：老宿主真把 messages / input / history 挂在 context 上时
  const tail = [];
  for (const key of ["messages", "input", "history"]) {
    const v = context && context[key];
    if (Array.isArray(v) && v.length) tail.push(v[v.length - 1]);
  }
  for (const c of tail) {
    if (typeof c === "string") return c;
    if (c && Array.isArray(c.content)) {
      const t = c.content.filter((x) => x && x.type === "text").map((x) => x.text).join(" ");
      if (t) return t;
    }
    if (c && typeof c.text === "string") return c.text;
  }
  return "";
}

/**
 * 创建 DSH 适配器。
 * @param {object} opts { config, now:Function }
 */
export function createDshAdapter({ config = {} } = {}) {
  let currentContext = null;
  let rendered = "";
  return {
    /** mount() 的贡献回调在每次取文本前调用它，把本轮 context 交进来 */
    setContext(context) { currentContext = context; },
    getTurnText() { return extractTurnText(currentContext); },
    applyContext(text) { rendered = text || ""; return rendered; },
    registerSkill(skill) {
      const ctx = currentContext?.__ctx;
      try {
        if (typeof ctx?.skills?.register === "function") {
          ctx.skills.register(skill);
          return true;
        }
      } catch { /* 宿主不支持就算了，技能不是必需品 */ }
      return false;
    },
    log(line) {
      if (config.quiet) return;
      try { console.warn("[adapter:dsh] " + String(line)); } catch { /* ignore */ }
    },
    lastRendered() { return rendered; },
  };
}

/**
 * 把 engine 装进 DSH：注册注入贡献、只读路由、可选技能。
 * mode = "off"（默认）只挂路由与技能，不注入；"shadow" 只算 + 写 trace；"clause" 才真返回文本。
 * @returns {{ engine:object, adapter:object }}
 */
export function mount({ ctx, config = {}, manifestPath }) {
  const adapter = createDshAdapter({ config });
  const engine = createEngine({ adapter, manifestPath, config });
  const mode = String(config.mode || "off");
  const contextName = config.contextName || "ctx-manifest:memory";
  const statusPath = config.statusPath || "/api/ctx-manifest/status";
  const checkupPath = config.checkupPath || "/api/ctx-manifest/checkup";

  // 1) 技能（可选；给了 skillFile 才注册）
  if (config.skillFile) {
    try {
      const raw = readFileSync(config.skillFile, "utf8");
      const body = raw.startsWith("---") ? raw.slice(raw.indexOf("---", 3) + 3).replace(/^\s*\r?\n/, "") : raw;
      const ok = ctx.skills?.register?.({
        name: config.skillName || "ctx-manifest",
        description: config.skillDescription || "上下文清单契约：把 system prompt 变成可预算、可审计、可回滚的配置。",
        content: body,
        source: "runtime",
      });
      if (!ok) adapter.log("宿主没提供 skills.register，技能跳过");
    } catch (err) {
      adapter.log("技能注册失败（不影响注入）：" + ((err && err.message) || err));
    }
  }

  // 2) 只读路由（status / checkup），宿主不支持 webServer 就跳过
  try {
    if (typeof ctx.inject === "function") {
      ctx.inject(["webServer"], (ws) => {
        const send = (res, code, obj) => {
          try {
            const buf = Buffer.from(JSON.stringify(obj, null, 2), "utf8");
            res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": buf.length, "Cache-Control": "no-store" });
            res.end(buf);
          } catch { /* 响应已断 */ }
        };
        const routes = [
          { kind: "exact", path: statusPath, handler: (req, res) => {
            try {
              const m = engine.manifest();
              const st = readState() || {};
              const idx = m ? checkIndex(m, { target: config.indexTarget || "INDEX.generated.md" }) : { ok: false, reason: "manifest 不可用" };
              send(res, 200, {
                ok: true,
                mode,
                manifest: m ? { units: unitsOf(m).length, budgets: m.budgets, limits: m.limits } : null,
                index: { ok: idx.ok, reason: idx.reason, rows: idx.rows || 0 },
                state: { turn: st.turn || 0, stamped: Object.keys(st.lastHit || {}).length },
                today: today(),
              });
            } catch (err) { send(res, 500, { ok: false, error: String((err && err.message) || err) }); }
          } },
          { kind: "exact", path: checkupPath, handler: (req, res) => {
            try { send(res, 200, engine.checkup()); } catch (err) { send(res, 500, { ok: false, error: String((err && err.message) || err) }); }
          } },
        ];
        for (const r of routes) ws.webServer.register(r);
      });
    }
  } catch (err) {
    adapter.log("只读路由注册跳过（不影响核心）：" + ((err && err.message) || err));
  }

  // 3) 注入贡献
  if (mode === "shadow" || mode === "clause") {
    try {
      if (typeof ctx.inject === "function") {
        ctx.inject(["systemPrompt"], (sp) => {
          sp.systemPrompt.context({
            name: contextName,
            order: Number(config.order || 100),
            text: (context) => {
              adapter.setContext(context);
              try {
                const res = engine.turn();
                return mode === "clause" ? (res.text || "") : "";   // shadow：算完只写 trace
              } catch (err) {
                adapter.log("route 失败（已降级为空串）：" + ((err && err.message) || err));
                return "";
              }
            },
          });
        });
      }
    } catch (err) {
      adapter.log("注入钩子没挂上（工具仍可用）：" + ((err && err.message) || err));
    }
  }

  return { engine, adapter };
}
