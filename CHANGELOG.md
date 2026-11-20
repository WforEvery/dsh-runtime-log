# Changelog

## Unreleased

- 新增 `pinOnFirstError`（默认开启）：首条 ERROR 到达时把已写内容封存为 `host-<pid>-<uuid>-incident.jsonl`，崩溃前的上下文不再被后续轮转覆盖；incident 文件计入 16 文件保留目标并随运行组回收，每运行最多封存一次。
## 0.1.2 - 2026-11-20

- 写入性能：drain 每周期将待写队列拼为单次批量写，替代逐条顺序 appendFile；在途记账改为条数与字节，行为与故障路径不变。
- 脱敏增强：新增 URL userinfo（`scheme://user:pass@host`）、凭据关键词后引号值、停用词保护的关键词后空格裸值三类规则；README 同步更新覆盖范围与残余缺口。
- Windows 权限：启动时检测日志目录位于 `%PUBLIC%` 之下并限频告警；README 说明 `0o600` 模式位在 Windows 上不生效、权限继承目录 ACL。
- 保留策略：`closing` 集合加入上限（4096），淘汰项回落到保守保护方向，不会被误删；注册表注释明确其去重用途而非安全边界。
- 修复 acquire 路径上 rootState exporter 的无效分配。

## 0.1.1 - 2026-11-17

- 修复常见环境变量及请求头凭据脱敏漏项和正常诊断文本误脱敏；名称截断会标记记录。
- 修复 Windows 目录别名及 worker_threads 同 PID 未知 run 的活动保护，并避免 maxFiles 较大时启动即清理少量旧日志。
- 旧运行清理与 writer drain 共用 `drainTimeoutMs` 期限；扫描未结算时，关闭中的 run 继续受保护直到清理结束。
- 本地 profile 验收改为独占随机临时目录，仅清理本次创建的文件。
- 公开安装包附带 MIT LICENSE；测试与验收资料仍仅保留本地。
- 明确记录 Node 24 原生 Error 堆栈访问器的安全限制与保留策略非硬配额边界。
- v0.1.0 标签及已发布附件保持原样。

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
