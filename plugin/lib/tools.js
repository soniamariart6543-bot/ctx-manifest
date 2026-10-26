// plugin/lib/tools.js —— 三个只读工具
//
// 边界（写死在代码里）：**这个插件不写任何文件**。
//   · 不写 manifest、不改 keys、不落 trace 以外的任何东西
//   · probe / checkup / status 全部是纯计算 + 读文件
// 写能力留在仓库的 CLI 脚本里（人手跑），插件只负责「看得见 / 量得出」。

// dsh-tools 用动态 import：装进 profile 后正常解析；在插件目录裸跑时降级成
// `defineTool = spec => spec`，只为让 import 自检能过（降级态下工具不会被真正注册）。
const dshTools = await import("@deepseek-ai/dsh-tools").catch(() => null);
const defineTool = dshTools?.defineTool || ((spec) => spec);

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, summarize } from "../../src/manifest.js";
import { route } from "../../src/router.js";
import { checkup, formatReport } from "../../src/checkup.js";
import { readState, today } from "../../src/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const DEFAULT_MANIFEST = join(REPO, "examples/mini/manifest.json");
const DEFAULT_CASES = join(REPO, "scripts/probe-cases.json");

/** 清单路径：显式参数 > 插件配置 > apply() 时绑定的路径 > 仓库自带示例。 */
function pickManifest(cfg, arg, bound) {
  const p = arg || cfg.manifestPath || bound || DEFAULT_MANIFEST;
  return resolve(String(p));
}

function load(manifestPath) {
  const r = loadManifest(manifestPath, { force: true, baseDir: dirname(manifestPath) });
  if (!r.ok) {
    const first = (r.errors || [])[0];
    throw new Error(`清单校验失败：${manifestPath}${first ? " · " + JSON.stringify(first) : ""}`);
  }
  return r.manifest || r;
}

/** 回归集判定：红线必须全中，改写 ≥8，闲聊泄漏必须 0。 */
function runProbe(manifestPath, casesPath) {
  const manifest = load(manifestPath);
  const baseDir = dirname(manifestPath);
  const cases = JSON.parse(readFileSync(casesPath, "utf8"));
  const always = new Set((manifest.units || []).filter((u) => u.when === "always").map((u) => u.id));

  const hits = (text) => {
    const r = route(text, { manifest, trace: false, baseDir, dshHome: baseDir });
    const ids = r.units.map((u) => u.id);
    return { all: ids, conditional: r.units.filter((u) => !always.has(u.id)).map((u) => u.id) };
  };
  const judge = (list) =>
    (list || []).map(([text, expect]) => {
      const got = hits(text);
      const want = expect || [];
      const missing = want.filter((id) => !got.all.includes(id));
      return { text, expect: want, got: got.all, missing };
    });

  const redline = judge(cases.redline);
  const real = judge(cases.real);
  const paraphrase = judge(cases.paraphrase);
  const chat = (cases.chat || []).map(([text]) => ({ text, got: hits(text).conditional }));

  const okOf = (rows) => rows.filter((r) => r.missing.length === 0).length;
  const leak = chat.reduce((n, r) => n + r.got.length, 0);
  const pass = okOf(redline) === redline.length && okOf(paraphrase) >= 8 && leak === 0;

  return {
    manifest: manifestPath,
    cases: casesPath,
    redline: { got: okOf(redline), total: redline.length },
    real: { got: okOf(real), total: real.length },
    paraphrase: { got: okOf(paraphrase), total: paraphrase.length },
    leak,
    pass,
    failures: [...redline, ...real, ...paraphrase]
      .filter((r) => r.missing.length)
      .map((r) => `${r.text} → 缺 ${r.missing.join(",")}`),
  };
}

/**
 * 注册三个工具。
 * @param {object} ctx 插件上下文（需要 tools 服务）
 * @param {object} cfg 插件配置
 * @param {object} engine mount() 返回的 engine（可为 null）
 */
export function registerTools(ctx, cfg = {}, engine = null, boundManifest = null) {
  const register = (tool) => {
    try {
      ctx.tools.register(tool);
      return true;
    } catch (err) {
      try {
        console.warn(`[dsh-ctx-manifest] 跳过工具 ${tool.name}：${(err && err.message) || err}`);
      } catch {
        /* ignore */
      }
      return false;
    }
  };

  let count = 0;

  // ------------------------------------------------------------ ctx_probe
  if (
    register(
      defineTool({
        name: "ctx_probe",
        description:
          "跑 ctx-manifest 的路由回归集：红线句必须全中、改写召回 ≥8/10、闲聊泄漏必须 0。" +
          "改清单的 keys 之后跑一次，就知道召回掉了没有。只读，不改任何文件。" +
          "路由回归 召回检查 清单回归 probe.",
        parameters: {
          manifest: { type: "string", description: "清单路径；默认用插件配置或仓库自带示例。" },
          cases: { type: "string", description: "用例路径；默认 scripts/probe-cases.json。" },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean" },
              pass: { type: "boolean" },
              redline: { type: "string" },
              real: { type: "string" },
              paraphrase: { type: "string" },
              leak: { type: "number" },
              failures: { type: "array", items: { type: "string" } },
              manifest: { type: "string" },
              error: { type: "string" },
            },
          },
          render: (_a, v) => {
            if (!v.ok) return [{ type: "text", text: "ERROR: " + v.error }];
            const out = [
              `清单：${v.manifest}`,
              `redline      ${v.redline}`,
              `recall(real) ${v.real}`,
              `paraphrase   ${v.paraphrase}`,
              `leak         ${v.leak}`,
              v.pass ? "结论：PASS" : "结论：FAIL",
            ];
            for (const f of v.failures || []) out.push("  ← " + f);
            return [{ type: "text", text: out.join("\n") }];
          },
        },
        async execute(args) {
          try {
            const manifestPath = pickManifest(cfg, args.manifest, boundManifest);
            const casesPath = resolve(String(args.cases || cfg.casesPath || DEFAULT_CASES));
            const r = runProbe(manifestPath, casesPath);
            return {
              ok: true,
              pass: r.pass,
              redline: `${r.redline.got}/${r.redline.total}`,
              real: `${r.real.got}/${r.real.total}`,
              paraphrase: `${r.paraphrase.got}/${r.paraphrase.total}`,
              leak: r.leak,
              failures: r.failures.slice(0, 20),
              manifest: r.manifest,
            };
          } catch (err) {
            return { ok: false, pass: false, leak: 0, failures: [], manifest: "", redline: "", real: "", paraphrase: "", error: String((err && err.message) || err) };
          }
        },
      }),
    )
  )
    count += 1;

  // ------------------------------------------------------------ ctx_checkup
  if (
    register(
      defineTool({
        name: "ctx_checkup",
        description:
          "对清单做六类体检：悬空引用 / 过期单元 / 预算越界 / 覆盖缺口 / 冲突窗口 / 索引事实。" +
          "输出可直接给人看的报告，结论分 ok / warn / error。只读。" +
          "体检 清单检查 预算 悬空 checkup.",
        parameters: {
          manifest: { type: "string", description: "清单路径；默认用插件配置或仓库自带示例。" },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean" },
              units: { type: "number" },
              code: { type: "number" },
              report: { type: "string" },
              error: { type: "string" },
            },
          },
          render: (_a, v) => {
            if (!v.ok) return [{ type: "text", text: "ERROR: " + v.error }];
            return [{ type: "text", text: v.report }];
          },
        },
        async execute(args) {
          try {
            const manifestPath = pickManifest(cfg, args.manifest, boundManifest);
            let report;
            if (engine && !args.manifest) {
              report = engine.checkup();
            } else {
              report = checkup(load(manifestPath), { dshHome: dirname(manifestPath) });
            }
            return {
              ok: true,
              units: report.units,
              code: report.code,
              report: formatReport(report),
            };
          } catch (err) {
            return { ok: false, units: 0, code: 1, report: "", error: String((err && err.message) || err) };
          }
        },
      }),
    )
  )
    count += 1;

  // ------------------------------------------------------------ ctx_status
  if (
    register(
      defineTool({
        name: "ctx_status",
        description:
          "看一眼清单的规模与预算：单元总数、分层分布、注入模式分布、各层预算上限，以及 STATE 里记的轮次。" +
          "装完插件先跑这个，确认「挂上了、看得见」。只读。",
        parameters: {},
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean" },
              today: { type: "string" },
              units: { type: "number" },
              byLayer: { type: "string" },
              byMode: { type: "string" },
              budgets: { type: "string" },
              turn: { type: "number" },
              manifest: { type: "string" },
              error: { type: "string" },
            },
          },
          render: (_a, v) => {
            if (!v.ok) return [{ type: "text", text: "ERROR: " + v.error }];
            return [
              {
                type: "text",
                text: [
                  `清单：${v.manifest}`,
                  `日期：${v.today}  已记轮次：${v.turn}`,
                  `单元：${v.units}  分层 ${v.byLayer}`,
                  `模式 ${v.byMode}`,
                  `预算 ${v.budgets}`,
                ].join("\n"),
              },
            ];
          },
        },
        async execute() {
          try {
            const manifestPath = pickManifest(cfg, null, boundManifest);
            const manifest = load(manifestPath);
            const s = summarize(manifest);
            let turn = 0;
            try {
              turn = Number(readState()?.turn || 0);
            } catch {
              /* STATE 缺失不影响摘要 */
            }
            const layerText = Object.entries(s.byLayer)
              .filter(([, n]) => n)
              .map(([k, n]) => `${k}=${n}`)
              .join(" ");
            const modeText = Object.entries(s.byMode)
              .filter(([, n]) => n)
              .map(([k, n]) => `${k}=${n}`)
              .join(" ");
            const budgetText = Object.entries(s.budgets || {})
              .map(([k, n]) => `${k}=${n}`)
              .join(" ");
            return {
              ok: true,
              today: today(),
              units: s.total,
              byLayer: layerText,
              byMode: modeText,
              budgets: budgetText,
              turn,
              manifest: manifestPath,
            };
          } catch (err) {
            return { ok: false, today: "", units: 0, byLayer: "", byMode: "", budgets: "", turn: 0, manifest: "", error: String((err && err.message) || err) };
          }
        },
      }),
    )
  )
    count += 1;

  return count;
}
