# Windows 缓存迁移闪退诊断

## 证据

用户提供的 v0.3.6 诊断 ZIP 含 721 字节应用日志、约 35 MB 的原生 minidump 和导出清单。未将用户原始日志或转储加入仓库。

运行环境为 Electron 44.5.1、Node 24.21.0、Windows x64，系统版本 10.0.26200。

北京时间 2026-10-03 02:42:20.426 开始把默认缓存迁移到 E 盘独立目录，随后仅记录 `cache.migration.copy`。没有 `copied`、`settings-saved`、`complete`，也没有 JavaScript 异常记录；约 5 秒后重新启动，记录 `session.previous-exit-unclean`。

minidump ExceptionStream 中的异常码为 `0xE06D7363`，抛出位置为 `KERNELBASE.dll+0xc187a`（Windows C++ 异常抛出入口）。将转储中的 C++ ThrowInfo RVA 与本地相同 Electron Windows 可执行程序核对，读取 CatchableType 的 TypeDescriptor，得到：

```text
.?AVfilesystem_error@filesystem@__fs@__Cr@std@@
.?AVsystem_error@__Cr@std@@
.?AVruntime_error@std@@
.?AVexception@std@@
```

转储模块的 CodeView PDB GUID 与 age 与本地 Windows 程序一致，确认异常类型映射使用了匹配的二进制。该转储没有解析出具体 filesystem_error 的 what() 文本，也未使用完整 PDB 展开调用栈；不能据此断言最初是权限、编码或磁盘错误。

## 判断

故障发生在同步目录复制步骤，原生 `std::filesystem::filesystem_error` 导致进程退出，绕过 JavaScript `try/catch`。日志显示尚未走到设置保存或旧目录删除步骤。

Node v24.21.0 的 `CpSyncCopyDir` 原生快路径使用会抛 C++ 异常的 filesystem 目录遍历和文件检查；上游有相同模式的报告：

- [nodejs/node #63970](https://github.com/nodejs/node/issues/63970)：Windows cpSync 原生目录快路径在文件系统错误下直接终止。
- [nodejs/node #62519](https://github.com/nodejs/node/pull/62519)：目录遍历异常及 Electron/非 ASCII 路径影响。该 PR 尚未合并，不能视为当前运行时已修复。
- [当前运行时原生文件实现](https://github.com/nodejs/node/blob/v24.21.0/src/node_file.cc)

## 修复

使用 `fs/promises.cp` 按条目复制到经过空目录校验的目标，避开 cpSync 原生目录快路径。异步 cp 使用 JS 路径检查和 libuv 文件操作，文件系统失败通过 Promise 拒绝回到现有错误处理。逐条复制是因为当前运行时的异步 cp 在 `errorOnExist` 下拒绝已存在的目标根目录。

迁移期间禁止开启中转站、清理缓存和并发保存设置；后台自动清理跳过，关闭应用等待迁移结束。复制或设置写入失败时清理本次复制项，保留源文件和原设置；设置内存值在 SQLite 写入成功后才切换。旧目录清理失败时保留新设置，明确提示旧缓存未清理并记录警告。

## 验证与限制

类型检查、生产构建、19 组服务/加密/平台/诊断测试通过，包含已有迁移完整性测试、新增中文路径、模拟 SQLite 写入失败回滚和迁移期间操作保护；15 组开发界面测试全部通过。

尚未在该 Windows 环境复测。已发布 v0.3.6 安装包不包含此修复；尚未选择新版本号、打包或发布修复版。
