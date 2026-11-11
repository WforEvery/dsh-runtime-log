# Changelog

## Unreleased

- 测试文件、验收脚本及验收报告仅本地保留，从 Git 跟踪和后续安装包中排除。
- 已发布的 v0.1.0 标签和 Release 附件保持原样。

## 0.1.0 - 2026-11-11

首个本地发布版本，源码以 ES module 直接运行，无编译步骤和第三方运行时依赖。

- 本地保存 Cordis WARN/ERROR，过滤 INFO/DEBUG。
- 有界编码队列与在途容量、严格 UTF-8 单条/单段上限、文件轮转及旧运行清理。
- 处理重复 fiber、跨 root 序号、关闭超时及异步清理竞态。
- 安全读取原始值与原生 Error，常见凭据模式尽力脱敏。
- 已在真实 desktop profile 安装、完整重启并验证日志落盘。

### 兼容范围

- DSH：仅 0.2.2-rc.1；Cordis：由宿主提供的 4.1.0。
- Node.js：>=24.16.0 <25，实测 24.16.0 与 24.21.0。
- 平台：Windows x64；其它版本或平台不在本次支持声明内。

### 已知限制

- 不收集全部 console、stdout/stderr、工具结果或历史 session。
- 惰性/accessor Error 堆栈可能不可用；自由文本脱敏不保证完全覆盖。
- 异常退出可损失末尾缓冲；超时的 run 保留到进程退出。
- 16 文件为默认的尽力保留目标，活跃或状态不明的进程日志优先保护。

### 复现发布

以下为原 v0.1.0 标签的发布复现步骤，该历史标签包含测试资料；在其源码目录执行：

    npm pack --ignore-scripts
    git archive --format=zip --prefix=dsh-runtime-log-0.1.0/ --output=dsh-runtime-log-0.1.0-source.zip v0.1.0

源码和发布包均不包含运行日志、profile 配置、凭据或临时测试产物。
