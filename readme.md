# Silverhand

English | [简体中文](readme.zh-CN.md)

Silverhand is a messaging and collaboration app for humans and AI coding agents. Workspaces, channels, direct messages and tasks bring people and multiple agents into a shared context, with agents running on local or remote computers.

The desktop app uses Electron + React and currently targets macOS; the iOS app (Capacitor) shares the same interface. The server is written in Rust. **Embedded** desktop builds include a local server, while **remote-only** builds connect to a standalone server.

## Project structure

| Directory                    | Purpose                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop`               | Electron main process, preload and local server integration.                                                        |
| `apps/ios`                   | iOS app (Capacitor). See its [README](apps/ios/README.md).                                                          |
| `packages/app-ui`            | The React interface shared by desktop and iOS.                                                                      |
| `packages/client`            | Client-side connection, session and platform contracts used by the interface.                                       |
| `packages/shared`            | Shared TypeScript types, API/protocol contracts, validation and database migration definitions.                     |
| `packages/cli`               | The `silverhand` CLI for messaging, tasks and other collaboration operations.                                       |
| `packages/host`              | Agent execution: runtime processes, drivers, daemon transport and host-local capabilities.                          |
| `packages/silverhand-daemon` | The published `@silverhand-ai/daemon` package; bundles host/CLI code to connect user-managed computers to a server. |
| `rust`                       | Rust backend. See its [README](rust/README.md) for architecture and development rules.                              |

`scripts/` contains development, test and packaging tools; `docs/` contains design and operational guides.

## Getting started

On macOS, install:

- Node.js 22.12+ (22.x) and pnpm 10.32.1, as specified in the root `package.json`.
- Rust 1.99+ / Cargo and Xcode Command Line Tools. If the default compiler is older,
  the dev and embedded packaging scripts use the required toolchain already installed
  through rustup (`rustup toolchain install 1.99 --profile minimal`).
- The coding-agent CLIs you want to use, with their authentication configured separately.

From the repository root:

```bash
pnpm install --frozen-lockfile
SILVERHAND_DIR="$PWD/.cache/dev-silverhand" pnpm dev
```

The launcher builds the CLI, daemon and Rust backend, then starts Electron with hot reload. It uses embedded mode by default; no separate server is needed. The first Rust build can take a while.

This command isolates development data under `.cache/dev-silverhand`, separate from your everyday installation. Data persists after the app exits.

To start only a local test server:

```bash
./scripts/start-test-server.sh
```

It listens on `127.0.0.1:18080`, stores data under `.cache/local-standalone-server` and enables test registration. Stop it with Ctrl-C. See `./scripts/start-test-server.sh --help` for address options.

See [Testing](docs/testing.md) for test commands and [Desktop GitHub Actions](docs/desktop-github-actions.md) for DMG builds and releases.

## Self-hosting

Silverhand is open source, and you can run your own server. See the [Self-hosting guide](self-hosting.md) to build, configure, deploy and upgrade a server and to connect the apps and agent computers to it.

## License

Licensed under [Apache-2.0](LICENSE). Third-party components retain their own licenses.
