# dsh-ctx-manifest

把本仓库的 [ctx-manifest](../README.md) 内核挂进 **DSH**（DeepSeek Harness）的插件。

装完之后你会得到三样东西，都能自己验证：

| 得到什么 | 怎么看见 |
|---|---|
| 插件出现在 DSH 插件列表 | 插件名 **`dsh-ctx-manifest`**，版本 `0.1.0` |
| 三个只读工具 | 会话里可调 `ctx_probe` / `ctx_checkup` / `ctx_status` |
| 两条只读路由 | `GET /api/ctx-manifest/status`、`GET /api/ctx-manifest/checkup` |

**它默认不注入任何上下文**（`mode: "off"`）。装上只增加「看得见、量得出」的能力，不改你的 system prompt。要真注入得自己显式打开。

---

## 装法

### 一、从仓库装（推荐，插件依赖仓库源码）

```bash
git clone <this repo> ctx-manifest
cd ctx-manifest
```

在你的 DSH profile 目录（例如 `~/.dsh/profiles/web`）里：

```bash
# 1) 加一条 file: 依赖，指向 clone 出来的仓库里的 plugin/
npm pkg set dependencies.dsh-ctx-manifest="file:../../path/to/ctx-manifest/plugin"

# 2) 加进 profile 的 bundle 列表
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.dsh.profile.bundles.push('dsh-ctx-manifest');fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"

# 3) 装依赖
pnpm install     # 或 npm install
```

重启 DSH —— 插件管理器里就能看到 `dsh-ctx-manifest`。

> 为什么要 `file:` 指到仓库里：插件的入口 `lib/index.js` 通过相对路径 `../../src` 引用内核，
> 跟着仓库走才有源码可读。这也是本插件**不单独发 npm tarball** 的原因 —— 发了 tarball 就只剩包装，没有内核。

### 二、想看它到底注册了什么

```bash
node plugin/lib/index.js    # 不行，要用假 ctx 跑（见下）
```

最小自检（不需要 DSH）：

```js
import { apply } from "./plugin/lib/index.js";
const tools = [];
apply({ tools: { register: (t) => tools.push(t) }, inject: () => {} }, {});
console.log(tools.map((t) => t.name));   // [ 'ctx_probe', 'ctx_checkup', 'ctx_status' ]
```

## 配置项

写在 profile 的插件配置里（键名与 `mount()` 一致）：

| 键 | 默认 | 含义 |
|---|---|---|
| `manifestPath` | 仓库自带 `examples/mini/manifest.json` | 你的清单文件。**一定要换**成自己的 |
| `home` | 清单所在目录 | 清单里相对 `path` 的解析根 |
| `mode` | `"off"` | `off` 不注入 · `shadow` 算完只写 trace · `clause` 真注入 |
| `tracePath` | 仓库 `.demo-trace/inject-trace.jsonl` | `shadow` / `clause` 下的 trace 落点 |
| `contextName` | `"ctx-manifest:memory"` | 注入段的名字 |
| `statusPath` / `checkupPath` | `/api/ctx-manifest/{status,checkup}` | 两条只读路由 |
| `quiet` | `false` | 关掉 adapter 的 console.warn |

## 三个工具看什么

| 工具 | 一句话 | 判据 |
|---|---|---|
| `ctx_probe` | 跑路由回归集 | 红线全中 · 改写 ≥8/10 · 闲聊泄漏 **0** |
| `ctx_checkup` | 六类体检 | 悬空 / 过期 / 预算 / 覆盖 / 冲突 / 索引事实，结论 ok·warn·error |
| `ctx_status` | 清单规模与预算 | 单元数、分层分布、模式分布、各层预算 |

三个工具**都不写文件**。写能力留在仓库的 CLI 脚本里（`scripts/`、`checks/`），由人决定什么时候跑。

## 边界

- 不提供 agent 循环、不调度工具、不管多轮状态 —— 它只算「这一段该不该进上下文」
- 不做向量检索（关键词 + 同义表，可解释、可 diff、零依赖）
- 不联网、不读环境变量里的密钥
- 换宿主 = 照 `src/adapter/` 的契约另写一个文件，`src/` 其余一行不改

## 许可

MIT，随主仓库。
