# Silverhand

Silverhand 是面向人与 AI coding agents 的即时通讯与协作应用。通过工作区、频道、私聊和任务，让人和多个 agent 在同一个上下文中协作，并管理本机或远程电脑上的 agent 运行。

桌面端基于 Electron + React，服务端使用 Rust。支持内嵌本地服务的 **embedded** 模式，以及连接独立服务的 **remote-only** 模式。目前桌面端面向 macOS。

## 项目结构

| 目录                                | 作用                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `apps/desktop`                      | Electron 桌面应用，包含主进程、React 界面和本地服务接入。                        |
| `packages/shared`                   | TypeScript 共享类型、API/协议合同、校验及数据库迁移定义。                        |
| `packages/cli`                      | `silverhand` 命令行工具，提供消息、任务等协作操作。                              |
| `packages/host`                     | Agent 执行层：管理 runtime 进程、驱动、daemon 连接和本机能力。                   |
| `packages/silverhand-daemon`        | 发布为 `@silverhand-ai/daemon` 的安装包，复用 host/CLI，将用户电脑接入远程服务。 |
| `rust/crates/backend-app`           | Rust 服务入口，负责配置、组件组装和启动。                                        |
| `rust/crates/backend-core`          | 领域模型、应用逻辑及端口定义。                                                   |
| `rust/crates/backend-server`        | HTTP / WebSocket 接口与协议适配。                                                |
| `rust/crates/backend-sqlite`        | SQLite 持久化与查询实现。                                                        |
| `rust/crates/backend-filesystem`    | 文件存储、运行环境探测等本机适配。                                               |
| `rust/crates/backend-observability` | 日志、请求关联及性能观测。                                                       |

`scripts/` 存放开发、测试和打包脚本，`docs/` 存放设计与操作说明。

## 本地启动

准备 macOS 开发环境：

- Node.js 22.12+（22 系列）和 pnpm 10.32.1（版本见根 `package.json`）。
- Rust 1.94+ / Cargo，以及 Xcode Command Line Tools。
- 使用 agent 时，另行安装并登录对应的 coding-agent CLI。

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
SILVERHAND_DIR="$PWD/.cache/dev-silverhand" pnpm dev
```

启动脚本会构建 CLI、daemon 和 Rust backend，然后启动支持热更新的 Electron 应用。默认走 embedded 模式，无需另起 server；首次 Rust 构建耗时较长。

上述命令将开发数据隔离在 `.cache/dev-silverhand`，避免与日常使用的数据混用。退出应用后数据保留。

如需单独启动本地测试 server（不启动桌面端）：

```bash
./scripts/start-test-server.sh
```

默认监听 `127.0.0.1:18080`，数据位于 `.cache/local-standalone-server`，开放测试注册；Ctrl-C 停止。桌面端连接本地独立 server 的参数说明见 `./scripts/start-test-server.sh --help`。

测试见 [testing.md](docs/testing.md)，DMG 构建与发布见 [Desktop GitHub Actions](docs/desktop-github-actions.md)。
