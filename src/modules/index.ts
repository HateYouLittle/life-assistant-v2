/**
 * 模块注册入口：核心（registry/daemon）不 import 模块内部文件，只调用本文件的
 * registerAllModules()。新增模块时在此 import 并注册。
 */
import "./bookkeeping/index.js";
import "./holiday/index.js";
import "./notify/index.js";
import "./schedule/index.js";
import "./weather/index.js";

export function registerAllModules(): void {
  // 模块通过 import 副作用注册
}
