# Rust server ECS 部署讨论清单

2026-09-07 根据 Shiki 的要求记录。本文是下一次部署前的建议与核查入口，
不是已经完成的部署验收，也不授权发布、重启、修改线上配置或数据。

**已定范围：下一次部署仅落实崩溃自动拉起。** Shiki 于同日明确，
其他条目属于运维改进备忘，不是本次部署的必做项或放行门槛。

## 推荐目标

单台 ECS 上由 systemd 托管独立 Rust server，现有反向代理负责 HTTPS；
SQLite 保持单实例运行权威。无需仅为进程自动恢复引入 Kubernetes。
实际部署前先读现行运维手册并核对现场，不凭历史对话推断当前状态：
`/Users/shiki/workspace/silverhand-aone-sandbox-server/ECS_OPERATIONS.md`。

## 本次部署范围

### 1. 进程托管与故障恢复

- 建议 systemd `Restart=on-failure`，设置重启间隔及启动频率限制，
  防止坏配置、迁移失败或磁盘满导致无限重启。
- 明确开机自启、服务运行用户、工作目录、二进制绝对路径和配置来源。
- 启动成功不等于业务就绪；不要未经应用支持就使用 `Type=notify` 或 watchdog。
- 在隔离环境验证崩溃恢复、连续失败限制、人工停止不会意外重启。
- 连续重启告警作为后续运维建议，本次不作为部署门槛。

## 后续运维备忘（不阻塞本次部署）

### 2. 优雅退出与后台任务监督

- SIGTERM 后停止接入新工作，处理在途请求，关闭 WebSocket，
  停止后台任务并释放数据库连接。
- 设置应用退出预算与 systemd 停止预算，后者留足清理余量；
  长连接不能使退出无限等待。
- Axum graceful shutdown 不替代业务任务管理。Tokio 子任务 panic
  可能只产生 JoinError，进程仍然存在；关键任务退出必须被观察，
  按任务职责明确恢复、标记未就绪或退出进程的策略。
- 在隔离环境验证活跃请求、WebSocket 和数据库工作期间的退出与重启。

### 3. 存活、就绪与监控

- 区分进程存活与业务就绪；就绪检查应反映必要组件是否可服务，
  不能仅返回静态 200，也不能每次做昂贵扫描。
- 明确健康检查调用者、失败阈值和处置，避免短暂依赖故障引发重启风暴。
- 监控连续重启、5xx、请求延迟、内存、磁盘空间、数据库错误及关键任务异常。
- 独立外部检查覆盖“主机或进程已无法自行报警”的情况。

### 4. 数据、备份与升级回退

- 迁移前备份，保留异机副本，并实际验证恢复；同盘备份不能覆盖整盘损坏。
- 按迁移规模验证准备耗时，不用普通请求或服务启动短超时强杀正常备份。
- 数据库升级后，旧 binary 未必可读；回退方案必须同时说明数据库兼容性、
  备份恢复及恢复点之后新增数据的处理，不能承诺“换回旧包即可”。
- 不让两个独立 server 同时接管同一数据目录；发布时明确旧实例退出边界。
- 不用外部 SQLite 客户端连接正在运行的用户数据库，包括外部 `.backup`。
  采用已经验证的应用备份流程，或停机后对安全副本操作。

### 5. 日志、安全与资源边界

- 结构化日志带时间、级别和必要请求关联；日志轮转、保留期和磁盘预算明确。
- 文件日志与 journald 的用途及重复存储开销明确；不能记录令牌、凭据或消息正文。
- 使用专用非 root 用户，限制配置文件权限和可写目录；生产密钥不写入仓库。
- 请求体、连接数、并发、超时和过载拒绝策略按场景设置。
- WebSocket 心跳、代理空闲超时与重连恢复配套，不能套用普通 HTTP 的短超时。
- TLS、反向代理信任头、来源校验与对外监听地址按实际拓扑核对。

### 6. 产物与协议配套

- 记录受测提交、目标架构/ABI、产物校验和及配置版本。
- 核 Desktop API epoch、host/outbound 协议和实际 runtime 能力；
  同一数字不自动证明所有开发期构建相容。
- 正式发布前再确定 server、daemon、Desktop 的升级顺序与拒绝旧端行为。
- 构建与 smoke 验收分开；使用明确隔离数据目录验证，不能以测试启动替换线上实例。

## 下次部署讨论的交付物

1. 只读确认当前进程托管方式，避免叠加两个守护进程。
2. 最小崩溃自动拉起配置，包含重启间隔及连续失败限制。
3. 验证异常退出会拉起、人工停止不会误拉起。
4. 经 Shiki 确认后执行；未确认前不变更线上服务。

其余运维项目以后单独决定，不因这份清单扩大部署范围。
具体参数须依据现场版本、负载与演练确定，本文不提供未经验证的可直接部署配置。

## 官方参考

- [systemd service 配置文档源码](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)
- [Axum graceful shutdown 示例](https://github.com/tokio-rs/axum/blob/main/examples/graceful-shutdown/src/main.rs)
- [Tokio JoinError：任务取消与 panic](https://docs.rs/tokio/latest/tokio/task/struct.JoinError.html)

## Rust observability 部署衔接

Rust 的 metrics 实现、ops 配置和隔离验证先独立 review，再进行服务切换。
观测代码通过不代表 ECS 已部署；运行实例仍以只读现场检查为准。

- 保持 Prometheus 的 `silverhand` target 为 `127.0.0.1:9464`，保留现有
  `silverhand_*` 应用指标、labels 和 buckets。主 API `/metrics` 必须为 403。
- 环境改用 [Rust server env contract](server-env-config.md)，明确数据库、
  blobs、日志根、API bind、allowed origins 和 deployment profile；不能直接
  把旧 Node 环境快照当作 Rust 配置。敏感值只进入权限受控的部署文件。
- 随 Rust 切换更新 overview dashboard 和 alert rules；Node heap/event-loop
  面板及告警已换成真实进程指标与 Tokio scheduling delay，不应提前覆盖仍跑
  Node 的生产观测配置。规则先通过 promtool，再安装到实际配置路径。
- 日志目录使用 `SILVERHAND_LOG_DIR`；每日 14 文件保留与旧 ECS 七日清理
  必须明确协调。logrotate 模板仅承担 100 MiB 尺寸兜底，不代表磁盘硬配额。
- 启动验收包括私有 metrics、Prometheus target up、一次真实 readiness probe
  的 histogram、新进程 RSS、host ready/close/协议 mismatch 与 daemon timeout
  数据。Node 专属序列为空不是 Rust 的故障，也不能用 Node 名伪报 Tokio 指标。
- ECS_OPERATIONS.md 的当前部署记录在实际切换时更新；候选 commit、checksum、
  unit/env、备份和回滚版本成套冻结，不把本清单当作上线证明。
