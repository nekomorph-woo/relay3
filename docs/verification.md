# 首版验证记录

验证日期：2026-10-02。验证环境：Apple Silicon Mac，Node.js 24.13.1，Electron 44.5.1。

## 已完成

- TypeScript 类型检查、生产构建及代码格式检查通过。
- 4 组服务端测试通过：配对与管理权限、PUT 跨域预检、接收确认、大文件流式上传和下载、大小与 SHA-256 校验、拒绝和取消、空文件、手动清理、完成后 1 小时清理、缓存迁移、数据库整理、重启恢复和设备凭证保留。
- 4 组 Electron 集成测试通过，分别运行在开发产物和已打包的 Mac Apple Silicon 应用：
  - 桌面与手机网页双向传输，文件内容一致；桌面真实写入接收目录。
  - 清理缓存后历史记录和本机正式文件保留。
  - 手机页面在 320、375、414、768 像素宽度无横向溢出，名称设置可保存。
  - 设备断开记录保存，中转站关闭后设置仍可保存。
  - 本机中转站与远端客户端同时运行；远端收发历史镜像到本机 SQLite。
  - 本机已接收文件可以单独删除，收发记录仍然保留。
- 应用包中未包含 React 源依赖、TypeScript、Playwright、Sharp 等开发依赖；前端 React 已编译进静态资源。
- 生产依赖 npm audit 检查：0 个已知漏洞。
- Mac 应用包的图标配置指向专属 `icon.icns`；Windows EXE 的图标资源与生成的 relay3 ICO 内容一致。
- 中文与英文语言资源保留，其他语言裁剪；前端图标压缩至约 31 KB。

测试数据、浏览器配置与数据库使用隔离的临时目录。当前机器代理会干扰 Node 的回环 HTTP / WebSocket，因此 HTTP 测试使用直连 curl，集成测试通过临时 Unix socket 转发本机调试连接；未修改系统代理配置。临时测试服务在验证完成后关闭。

## 产物

- `release/relay3-1.0.0-mac-arm64.dmg`：Apple Silicon Mac 安装包。
- `release/relay3-1.0.0-mac-x64.dmg`：Intel Mac 安装包。
- `release/relay3-1.0.0-win-x64.exe`：Windows x64 安装包。
- `release/mac-arm64/relay3.app`：当前 Mac 可以直接打开的应用。

## 尚未实机验证

Windows 与 Intel Mac 的实际安装和运行、iOS Safari 与 Android 实机的锁屏及后台传输行为。手机响应式与双向收发已在 Chromium 的移动视口中验证，不能替代真实 Safari 或手机系统行为验证。安装包尚未配置商业代码签名和 Apple 公证。

界面截图保存在 `design/qa/`。

## v0.3.1 更新

- 采用用户选定的 02 号 r3 合字，更新网页、Dock、Mac 与 Windows 安装程序图标。
- 页面底部品牌文字移除，标题保留 relay3，左下角显示 relay3 0.3.1。
- 发布目标仅为 Mac Apple Silicon 与 Windows x64。
- TypeScript 检查、生产构建与 4 组服务测试通过。
- 安装包仍未商业签名或 Apple 公证；Windows 尚未实机运行验证。
- 安装包通过 GitHub Release 提供，上传验证后删除本地安装包。
