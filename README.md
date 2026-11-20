# dsh-runtime-log

为 DeepSeek Harness（DSH）提供本地 Cordis `WARN` / `ERROR` 日志留存，便于在重启后排查运行问题。日志以 JSONL 写入本机，并用有界队列、文件轮转及旧运行清理限制资源占用。

[GitHub Release](https://github.com/WforEvery/dsh-runtime-log/releases) · [npm](https://www.npmjs.com/package/dsh-runtime-log) · [变更记录](CHANGELOG.md) · [问题反馈](https://github.com/WforEvery/dsh-runtime-log/issues) · [MIT 许可证](LICENSE)

> 当前修复版本为 **0.1.3**，已发布至 [npm](https://www.npmjs.com/package/dsh-runtime-log)。这是第三方 DSH 插件，不是 DeepSeek 官方产品。它只在下列支持环境中发布和验证；部署前请阅读隐私及限制说明。

## 功能

- 通过 Cordis logger exporter 接收 WARN 和 ERROR，异步写入本地 JSONL 文件；INFO / DEBUG 不保存。
- 限制队列记录数、队列字节数及单条编码大小，到达单段文件上限时轮转。
- 按运行实例区分文件，并在启动时尝试清理可确认已关闭的旧运行日志。
- 事件封存：可配置触发（首条 ERROR / 首条 WARN / 静默期后的新事件），把当前段（自上次轮转以来）封存为独立 incident 文件，崩溃前的上下文不会被后续轮转冲掉；正常关闭时归档到 `archive/` 目录。
- 对常见凭据文本格式进行尽力脱敏；不遍历或序列化任意参数对象。
- 只使用 Node.js 内置模块，无第三方运行时依赖；插件本身不发起网络请求或上传日志。

## 兼容性

以下为 **0.1.3 的支持声明**，并非对其它版本或平台的兼容承诺。

| 组件 | 支持范围 | 已验证环境 |
| --- | --- | --- |
| DSH | **`>=0.2.2-rc.1`**（含更新版本与未发布的预发布版本） | 0.1.3 / 0.1.2 本地冒烟验收；0.1.1 隔离宿主验收；0.1.0 曾通过真实桌面完整重启；更新版本按兼容默认支持，未逐一验证 |
| Cordis | **`4.1.0`**（由 DSH 提供，随宿主版本变化） | 由上述 DSH 版本提供 |
| Node.js | **`>=24.16.0 <25`** | `24.16.0`、DSH 自带的 `24.21.0` |
| 操作系统与架构 | **Windows x64** | Windows 桌面宿主 |

Node.js 区间对应 Node 24 发行线，区间内并非每个补丁版本都逐一测试。DSH 低于 `0.2.2-rc.1` 的版本不在支持范围内；`0.2.2-rc.1` 及更新的版本（包括尚未发布的预发布版本）默认按兼容支持：宿主以 semver 范围校验 `engines.dsh`，并对预发布版本启用比较（`includePrerelease`），因此 `>=0.2.2-rc.1` 会放行后续所有正式版与预发布版。Node.js 20–23 或 25+、macOS、Linux 和 Windows ARM64 均不在支持范围内。

宿主门禁信息位于 [package.json](package.json)：`engines.node`、`engines.dsh`、`dsh.bundle.platforms`、`os` 与 `cpu`。 [cordis.patch.yml](cordis.patch.yml) 只负责将插件 bundle 插入 profile，不承载版本门禁。更新版本的 DSH 未逐一验证；升级后若出现行为异常，请携带宿主版本反馈。

## 安装

需要能管理目标 DSH profile 及其依赖的环境。开始前确认 profile，并备份其依赖清单、锁文件和用户 patch。

1. 在目标 profile 目录安装指定版本：

   ```powershell
   pnpm add dsh-runtime-log@0.1.3 --ignore-scripts
   ```

2. 在该 profile 的 `dsh.profile.bundles` 中添加 `dsh-runtime-log`，保留原有 bundle：

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": ["existing-bundle", "dsh-runtime-log"]
       }
     }
   }
   ```

3. 在 profile 目录安装依赖并完整退出、重新启动 DSH：

   ```powershell
   pnpm install --ignore-scripts
   ```

4. 确认目标 profile 加载了该 bundle，再检查日志目录是否生成运行文件。插件包声明了 DSH 版本和 Windows x64 限制，宿主可能拒绝不兼容环境。

插件运行时不会修改 profile。安装和 profile 组合属于宿主管理操作；本插件不会自动启用或更改其它 bundle。

## 配置

不提供配置时使用下表默认值。默认日志目录为 `$DSH_HOME/runtime-log`；未设置有效的 `DSH_HOME` 时为 `~/.dsh/runtime-log`，Windows 上通常位于 `%USERPROFILE%/.dsh/runtime-log`。

| 字段 | 默认值 | 范围与含义 |
| --- | --- | --- |
| `directory` | 默认日志目录 | 绝对路径，支持 `~`、`~/` 和 `~\`；相对路径回退默认目录 |
| `maxFileBytes` | `5242880`（5 MiB） | 单段文件上限，64 KiB–100 MiB |
| `maxFiles` | `4` | 每次运行保留段数，2–32，包含当前段 |
| `maxQueueRecords` | `2000` | 待写及在写记录合计上限，1–50000 |
| `maxQueueBytes` | `1048576`（1 MiB） | 待写及在写编码字节合计上限，4 KiB–16 MiB |
| `maxEntryBytes` | `16384`（16 KiB） | 单条记录编码上限，256 B–`min(256 KiB, maxQueueBytes)` |
| `flushIntervalMs` | `200` | 批量写入周期，25–60000 ms |
| `drainTimeoutMs` | `1000` | 卸载时等待排空的期限，25–10000 ms |
| `pinOn` | `error` | 封存触发：`error`（首条 ERROR）、`warn`（首条 WARN 或 ERROR，建议配合 `pinQuietMs`）或 `off`；`pinOnFirstError: false` 作为旧别名等价于 `off` |
| `pinQuietMs` | `0` | 0–600000；大于 0 时仅当距上一条日志至少间隔该毫秒数才触发封存，用于「空闲后的第一条 WARN 开启新事件」 |
| `maxTotalFiles` | `16` | 2–256；启动清理时跨运行保留的日志文件总数目标 |
| `archiveIncidents` | `true` | 正常关闭时把 incident 文件移入 `archive/` 子目录，避免随运行组被清理 |
| `archiveMaxFiles` | `16` | 1–256；`archive/` 中最多保留的 incident 文件数（按修改时间保留最新） |

数值配置要求安全整数；超出范围会被限制到允许边界，类型无效时使用默认值。单条记录的实际大小还受队列和文件上限约束。

可在用户 patch 中按 bundle 的 `id` 覆盖设置：

```yaml
- id: dsh-runtime-log
  config:
    directory: "D:/dsh-logs"
    maxFileBytes: 5242880
    maxFiles: 4
    maxQueueRecords: 2000
    maxQueueBytes: 1048576
    maxEntryBytes: 16384
    flushIntervalMs: 200
    drainTimeoutMs: 1000
    pinOn: error
    pinQuietMs: 0
    maxTotalFiles: 16
    archiveIncidents: true
    archiveMaxFiles: 16
```

路径仅为示例，目录必须允许 DSH 宿主写入。用户 patch 中的 `config` 整体替换较早层配置；未填写字段由插件补默认值。同一进程内，相同日志目录共享写入器，首次创建时的参数生效。建议同一目录只配置一套参数。

## 日志与保留

文件名为 `host-<pid>-<uuid>.jsonl`，轮转段使用 `.1`、`.2` 等后缀。默认每次运行最多保留 4 个常规段（封存生效时另有至多 1 个 incident 文件），每段最多 5 MiB。

封存由 `pinOn` 控制（默认 `error`）：检测到第一条符合条件的记录（ERROR；或 `pinOn: warn` 时的任意 WARN / ERROR）会把**当前段**（自上次轮转以来写入的内容）重命名为 `host-<pid>-<uuid>-incident.jsonl`，随后新段从该记录开始写入。`pinQuietMs` 大于 0 时，只有距上一条日志至少间隔该毫秒数的「新事件起点」才会触发封存（建议与 `pinOn: warn` 搭配使用）。incident 文件不参与后续轮转删除——后续轮转只会覆盖常规段——因此「事件起点之前的那一段」会保留下来；更早、已经轮转出去的段不在封存范围内。在「`pinOn: warn` + `pinQuietMs`」的事件模式下，无可封存内容时不会消耗封存机会，之后的事件仍可触发；`error` 模式保持「首条 ERROR 仅尝试一次」。定位崩溃起点时，请看 incident 文件的尾部，再到新段（常规 `.jsonl` 段）里找第一条记录。

跨运行保留由 `maxTotalFiles`（默认 16）控制。`archiveIncidents` 开启时（默认），正常关闭会把 incident 文件移入 `archive/` 子目录，不受运行组回收影响；`archiveMaxFiles`（默认 16）按修改时间保留最新的若干个。强制结束进程不会触发归档，incident 留在日志目录并随运行组按原规则回收。

每行是一条 UTF-8 JSON 记录：

```json
{"time":"2026-01-01T00:00:00.000Z","level":"warn","name":"example-plugin","message":"Example warning"}
```

| 字段 | 含义 |
| --- | --- |
| `time` | UTC ISO 8601 接收时间 |
| `level` | `warn` 或 `error` |
| `name` | logger 名称；超长名称会截断并标记记录 |
| `message` | 有界格式化并尽力脱敏后的消息 |
| `stack` | 可选堆栈；不可安全读取时写入 `[Stack unavailable]` |
| `truncated` | 内容被截断时为 `true` |

普通对象不展开为完整结构，通常用 `[Object]` 等标记表示。为避免执行用户自定义的 getter 或 `Error.prepareStackTrace`，插件只读取可安全取得的数据属性。**在支持范围内的 Node 24 中，标准原生 Error 的 `stack` 是 accessor，通常会记录为 `[Stack unavailable]`，而不保存真实堆栈。**这是有意的安全与可诊断性取舍，不表示日志中必定包含错误堆栈。

启动和停止时，插件尝试写入 `dsh-runtime-log` WARN marker，消息分别以 `[plugin-event:start]` 和 `[plugin-event:stop]` 开头。Marker 与业务日志共用队列，队列压力下也可能丢失；停止 marker 中的计数是关闭前快照，不是最终排空结果。插件卸载可等待启动时的日志清理，但写入排空和清理共用 `drainTimeoutMs` 截止时间；期限内未完成则卸载返回，关闭中的 run 继续受保护，直到清理最终结算。

启动时的旧运行清理以 **16 个可识别日志文件** 为尽力目标：不同 PID 的旧运行需要确认进程已退出；同一 PID 的旧运行需要由当前 isolate 确认已完全关闭。只处理严格匹配命名规则的常规文件，并按旧运行组的时间由早到晚清理。当前、关闭中及状态未知的运行均受保护；来自其它 worker isolate、无法确认关闭状态的同 PID run 会保守保留。当前首段尚未出现在扫描中时，只为它预留一个文件位置，不预留未来轮转段。16 个文件是尽力目标而非硬磁盘配额；并发活动进程、慢扫描、worker isolate 或后续轮转都可能使目录暂时超过目标，单纯增大 `maxFiles` 不会再让旧运行预算归零。

## 隐私与限制

- **覆盖范围有限。** 仅保存插件加载后经过 Cordis logger 的 WARN / ERROR；不会收集全部 `console`、stdout / stderr、工具结果或会话历史，也不追补加载前的记录。
- **脱敏并非秘密清除保证。** 插件会处理已知凭据格式，但任意自由文本、未知编码、截断边界或尚未识别的格式仍可能含秘密。显式 `Authorization` / `Proxy-Authorization` 字段从 scheme 到该行末尾整体遮盖，同一行后续的无关诊断文本也可能被隐藏；Cookie 与 Set-Cookie 字段整体遮盖。为减少英文诊断误报，scheme 规则保留 `Basic authentication failed` 和 `Bearer authentication required` 两类已识别文案。URL userinfo（`scheme://user:pass@host`）中的 `user:pass@` 整段遮盖，仅识别冒号形式，`host:port` 不受影响。凭据关键词（password / token / secret 等）后直接跟随的引号值会遮盖；后跟空格裸值时也遮盖，但为保持诊断可读，裸值若以常见英文停用词开头（如 `password is required`、`token was invalid`）则跳过——代价是以停用词开头或无凭据关键词的值仍可能漏过。插件不会主动读取会话或凭据，其他组件传给 logger 的文本仍可能包含敏感信息。
- **Windows 文件权限继承目录 ACL。** 插件创建文件使用的 `0o600` 模式位在 Windows 上不生效，日志文件的实际权限完全继承目录 ACL。请勿将 `directory` 配置到 `%PUBLIC%` 等公共或共享位置；插件在创建写入器时检测到目录位于 `%PUBLIC%` 之下会向 stderr 输出限频告警。建议日志目录仅当前用户可读。
- **日志可能丢失。** 队列满时会丢弃记录，超长内容会截断；强制结束、断电、关闭超时或 I/O 错误都可能使末尾记录缺失。异步写入不提供崩溃持久性保证。
- **写入错误会停用对应写入器。** 文件创建、写入或轮转失败后不会无限重试，会尝试向 stderr 输出限频提示。需修复目录或磁盘问题后重载插件或重启宿主。
- **日志按敏感诊断材料保管。** 文件为本地文本，插件不加密。分享前应人工检查并删除令牌、Cookie、个人信息及其它敏感内容；使用合适的目录权限。
- **不是安全审计或恢复系统。** 请勿将其作为审计完整性、故障恢复或安全隔离的唯一依据。

## 卸载

从目标 profile 的 bundle 列表和依赖清单移除本包，按 profile 流程更新依赖后完整退出并重启 DSH。卸载不会自动删除现有日志；确认宿主已不再写入后，可自行归档或清理。

## 问题反馈

请在 [GitHub Issues](https://github.com/WforEvery/dsh-runtime-log/issues) 提交插件、DSH、Cordis 与 Node.js 版本、系统架构、复现步骤及经过人工检查的最小日志片段。请勿上传完整 profile、会话存档或凭据。兼容范围以实测和发布说明为准。

## 许可证

本项目采用 [MIT License](LICENSE)。软件按现状（AS IS）提供，不附带明示或默示担保；具体授权、免责和责任限制以许可证全文为准。
