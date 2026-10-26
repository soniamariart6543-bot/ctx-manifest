// src/index.js —— 包入口
//
// 设计原则：**默认导出的是纯库**，宿主相关的东西一律通过 adapter 注入。
// 所以在这里 import 不会触碰任何宿主 SDK、不会读任何本机文件、不会猜默认配置。
//
// 三种用法：
//   1) 纯库：   import { createEngine } from "ctx-manifest";          // 自己写 adapter
//   2) 命令行： createEngine({ adapter: createStandaloneAdapter(), manifestPath })   // demo / CI
//   3) DSH：    import { mount } from "ctx-manifest/adapter/dsh.js";  // 宿主插件里挂载

export { createEngine } from "./bootstrap.js";

export { route, scoreUnit, scoreAll, select, normalize } from "./router.js";
export { loadManifest, unitsOf, budgetsOf, limitsOf } from "./manifest.js";
export { checkup, formatReport } from "./checkup.js";
export { renderUnit, buildText } from "./inject.js";
export { detectConflicts } from "./buffer.js";
export { readState, stampLastHit, today } from "./store.js";
export { writeIndex, checkIndex } from "./indexer.js";

export { createStandaloneAdapter } from "./adapter/standalone.js";
