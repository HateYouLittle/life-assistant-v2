/**
 * 模块注册入口：核心（registry/daemon）不 import 模块内部文件，只调用本文件的
 * registerAllModules()。新增模块时在此 import 并注册。
 */
export function registerAllModules(): void {
  // 后续阶段接入：weather / airquality / holiday / schedule / bookkeeping / notify
}
