# dsh-runtime-log

把 DSH Cordis logger 的 WARN / ERROR 记录写到本机 JSONL，供进程重启后排查。插件只注册 logger exporter，不读取会话历史或凭据，不联网，不提供模型工具、UI 或 system prompt。

## 状态

本地首版 0.1.0；已安装到 desktop profile，并在完整重启后通过真实宿主日志验收。尚未发布至 npm 或远程仓库。插件运行时不修改 profile；新增 bundle 后需要完整退出并重新启动 DSH。

0.1.0 的兼容范围如下：

| 项目 | 首版支持范围 | 验证依据 |
|---|---|---|
| DSH | **仅 0.2.2-rc.1** | 隔离 profile、桌面真实安装与完整重启 |
| Cordis | **4.1.0**（由该 DSH 版本提供） | 真实 Context 生命周期、20 次重载 |
| Node.js | **>=24.16.0 <25** | 24.16.0、DSH 自带 24.21.0 均实测 |
| 系统 | **Windows x64** | 本机桌面宿主和文件轮转验收 |

Node 区间声明的是上述两个测试点所在的 Node 24 发行线，并非每个补丁版都逐一实测。Node 20–23、Node 25+、其它 DSH 版本、Mac/Linux 及 Windows ARM64 不在本次支持声明内。包清单写入对应的 Node、DSH、系统和架构范围；bundle 平台门禁仅允许 win32。

原生 Error 仅保留可安全读取的自有字符串堆栈；惰性或 accessor 堆栈写为 `[Stack unavailable]`，避免执行自定义 getter 或格式化代码。

## 行为

- 默认目录：`$DSH_HOME/runtime-log`，否则 `~/.dsh/runtime-log`；`directory` 可配绝对路径（支持 `~`）。DSH_HOME 的 `~` 与纯空白回退规则与宿主 helper 一致。
- 同一进程内、同一规范化目录只有一个共享 sink 文件；重复 fiber、重复 root 不会重复写记录。每个 logger service 注册一个 exporter，按引用计数释放；先卸载的实例不会停掉仍存活的实例。
- 不同 logger root 的 `sn` 命名空间独立；同一 logger service 内按 `sn` 去重（编译版 Cordis 会为每个 exporter 新建 message 对象），不会把另一个 root 的真实记录误删。
- 每个运行实例使用 `host-<pid>-<uuid>.jsonl`；默认每段 5 MiB，当前段加 3 个轮转段。
- 队列默认上限 2,000 条 / 1 MiB（含正在写入的批次）；压力下丢弃最旧记录并计数。
- 只接收 WARN / ERROR；INFO / DEBUG 被忽略。
- 启动时异步执行 retention，并为当前 run 的 maxFiles 段预留空间；同进程已关闭的旧 run 会在当前和关闭中的活动路径保护后清理。
- 默认配置下目标上限是 16 个 run 文件（含轮转）。其它进程的 live / unknown run 不删除；maxFiles 大于 16 或并发活跃进程较多时，实际目录可暂时超过目标上限。
- 生命周期 marker 使用同一个 sink 的普通 WARN 记录，name 为 `dsh-runtime-log`，message 以 `[plugin-event:start]` / `[plugin-event:stop]` 开头。启动 marker 只排入有界队列，不承诺插件返回前落盘。
- stop marker 在调用 sink.close() 之前读取计数快照；其 buffered / inFlight 等字段是快照值，不是最终 drain 结果。最后一个 fiber 的卸载等待 sink.close() 自己的 drain deadline；插件不等待 retention。marker 与业务日志共用队列、脱敏、单条上限、轮转和丢弃策略，因此压力下 marker 也可能被丢弃。
- 若 close 超时，尚未结算的 OS 写入无法取消；该 run 会继续留在保护集合直至进程退出，以免异步清理误删仍可能写入的文件。

## 配置

设置 bundle 的 `config` 字段覆盖默认值：

- `directory`：绝对目录路径，支持 `~/`；相对路径回退默认目录。
- `maxFileBytes`：单段字节上限，64 KiB 至 100 MiB，默认 5 MiB。
- `maxFiles`：单次运行保留段数，2 至 32，默认 4（轮转段数 = maxFiles - 1）。
- `maxQueueRecords`：待写与在写记录数上限，1 至 50,000，默认 2,000。
- `maxQueueBytes`：待写与在写编码字节上限，4 KiB 至 16 MiB，默认 1 MiB。
- `maxEntryBytes`：单条记录最大编码字节数，256 至 min(256 KiB, maxQueueBytes)，默认 16 KiB。
- `flushIntervalMs`：批量写盘周期，25 至 60,000 ms，默认 200 ms。
- `drainTimeoutMs`：卸载时最多等待排空时间，25 至 10,000 ms，默认 1,000 ms。

无效或 hostile 的配置不会向外抛出：非对象、非法数值、相对目录都会回退到默认值或默认目录。配置按受信任 JSON 读取固定字段，不做通用对象遍历。

## 隐私与限制

- 不保存原始 args 对象；只格式化有限类型并做尽力脱敏（识别到的密钥键、Bearer/API key 等）。不能保证自由文本、未知编码或所有自定义错误内容中的秘密都被清除。
- 只覆盖经过 Cordis logger 的记录，不覆盖 console/stdout/stderr 的全部内容、session JSONL、工具执行结果或插件加载前的消息。
- 不是崩溃安全的：强制结束、断电或关闭超时可能丢失末尾缓冲记录。
- 日志与回执是本机敏感诊断材料，应按敏感日志保管。
- 只使用 Node 内置模块，无运行时依赖，无网络、上传或 profile 写入。

## 文件

- [src/index.js](src/index.js)：插件入口、共享 registry、生命周期回执与 retention 集成。
- [src/log-sink.js](src/log-sink.js)：有界格式化、队列、异步写入与轮转。
- [src/retention.js](src/retention.js)：跨运行文件识别、分组与清理。
- [cordis.patch.yml](cordis.patch.yml)：bundle patch。
- [package.json](package.json)：清单、`dsh.bundle` 与测试脚本。
- [CHANGELOG.md](CHANGELOG.md)：0.1.0 版本变更记录。
- [test/plugin.test.mjs](test/plugin.test.mjs)：入口、共享/去重、重载、回执与 retention 集成测试。
- [test/log-sink.test.mjs](test/log-sink.test.mjs)：sink 的队列、脱敏、轮转与关闭测试。
- [test/retention.test.mjs](test/retention.test.mjs)：retention 的命名识别、存活判断与错误收敛测试。
- [scripts/verify-cordis.mjs](scripts/verify-cordis.mjs)：对真实 Cordis 的 exporter 生命周期、重复 fiber、跨 root 与 20 次重载保留上限验证。
- [scripts/verify-profile.ps1](scripts/verify-profile.ps1)：隔离 DSH_HOME 的 profile 组合校验，并检查真实 profile 未被改动。
- [VERIFICATION.md](VERIFICATION.md)：本机最终测试与验收回执。

## 本地测试

需要 Node.js >=24.16.0 <25；不需要安装依赖：

    npm test
    node --test test/plugin.test.mjs

测试只写系统临时目录并在结束后清理；不要拿生产 profile 的日志路径做测试。

## 安装

把一个 profile 的依赖指向本包，并把 `dsh-runtime-log` 加入该 profile 的 `dsh.profile.bundles`，然后完整退出并重启 DSH。本机 desktop 安装与重启实测已通过；`engines.dsh` 仅声明 0.2.2-rc.1。
