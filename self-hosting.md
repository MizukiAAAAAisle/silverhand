# Self-hosting Silverhand

This guide runs your own Silverhand server and connects the desktop app, the iOS app and your agent computers to it.

## How the pieces fit

- **Server**: a single Rust executable, `silverhand-backend`. It serves the HTTP API and WebSockets and stores everything in one SQLite database plus a blob directory on local disk. There is no separate database server.
- **Clients**: the desktop app (macOS) and the iOS app connect to the server over HTTPS.
- **Agent computers**: agents run on machines you own, not on the server. Each machine runs the `@silverhand-ai/daemon` package, which opens an outbound WebSocket to the server. The server never needs network access to those machines.

Each server instance owns its data directory and runs as one process.

## Requirements

- A Linux x86_64 host with glibc 2.31 or newer. On other platforms, build natively with Cargo (step 1).
- A domain name and a TLS certificate. Clients only connect to non-local servers over HTTPS.
- A reverse proxy that terminates TLS and forwards WebSocket upgrades, such as Nginx or Caddy.

For a machine at home without a public IP, such as a Mac mini, [Cloudflare Tunnel](#home-mac-with-cloudflare-tunnel) replaces the certificate, the reverse proxy and port forwarding.

- To build: Docker, or Rust 1.99+ (see the [Getting started](readme.md#getting-started) requirements).

## 1. Build the server

To build a Linux x86_64 binary from macOS or Linux using Docker, run:

```bash
./scripts/build-rust-linux.sh
```

The executable and its checksum are written to `.cache/linux-server/<timestamp>-<commit>/`. The script also checks glibc compatibility and runs a startup smoke test. See [rust/BUILDING.md](rust/BUILDING.md) for details.

To build natively on the target machine instead, run this from the repository root:

```bash
cargo build --release --locked --manifest-path rust/Cargo.toml --bin silverhand-backend
```

The binary is written to `rust/target/release/silverhand-backend`. Build from the repository root so that the SQLite build settings in `.cargo/config.toml` apply.

## 2. Configure

The server is configured only through environment variables. Create the directories and an environment file readable only by the service user:

```bash
mkdir -p ~/silverhand-data/blobs ~/silverhand-data/logs ~/.config/silverhand-server
chmod 700 ~/silverhand-data ~/.config/silverhand-server
```

`~/.config/silverhand-server/server.env` (mode `0600`):

```bash
SILVERHAND_DEPLOYMENT_PROFILE=remote-only
SILVERHAND_DATABASE_PATH=/home/silverhand/silverhand-data/silverhand.db
SILVERHAND_BLOBS_ROOT=/home/silverhand/silverhand-data/blobs
SILVERHAND_LOG_DIR=/home/silverhand/silverhand-data/logs
SILVERHAND_LISTEN_ADDR=127.0.0.1:8080
SILVERHAND_ALLOWED_ORIGINS=https://silverhand.example.com
```

| Variable                        | Notes                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `SILVERHAND_DEPLOYMENT_PROFILE` | Always `remote-only` for a self-hosted server.                                        |
| `SILVERHAND_DATABASE_PATH`      | SQLite database file. It is created on first start.                                   |
| `SILVERHAND_BLOBS_ROOT`         | Attachment storage directory.                                                         |
| `SILVERHAND_LOG_DIR`            | Diagnostic and audit log directory.                                                   |
| `SILVERHAND_LISTEN_ADDR`        | Numeric IP and port. Bind to loopback and expose the server only through the proxy.   |
| `SILVERHAND_ALLOWED_ORIGINS`    | Your public HTTPS origin, without a path. Comma-separate multiple origins.            |
| `SILVERHAND_DISABLE_SIGNUP`     | Optional. `1` closes public signup.                                                   |
| `SILVERHAND_MIGRATE`            | `1` allows an existing database to be upgraded on start. See [Upgrading](#upgrading). |

Use absolute paths. The full reference is in [docs/server-env-config.md](docs/server-env-config.md).

## 3. Run as a service

The repository includes a systemd user unit, [ops/deployment/silverhand-server.service](ops/deployment/silverhand-server.service). It expects:

- the binary at `~/.local/lib/silverhand/current/silverhand-backend`;
- the environment file at `~/.config/silverhand-server/server.env`;
- the working directory `~/silverhand-data`.

```bash
mkdir -p ~/.local/lib/silverhand/current ~/.config/systemd/user
install -m 755 silverhand-backend ~/.local/lib/silverhand/current/
cp ops/deployment/silverhand-server.service ~/.config/systemd/user/
loginctl enable-linger "$USER"   # keep the service running after logout
systemctl --user daemon-reload
systemctl --user enable --now silverhand-server
```

The unit restarts the server after a crash. Stopping it sends SIGTERM and waits for a clean shutdown. View logs with `journalctl --user -u silverhand-server`; the server also writes logs to `SILVERHAND_LOG_DIR`.

Check that the server is up:

```bash
curl -fsS http://127.0.0.1:8080/api/health    # liveness
curl -fsS http://127.0.0.1:8080/readyz        # database and listener readiness
```

## 4. Put HTTPS in front

Forward all paths to the server and allow WebSocket upgrades. Attachments are up to 10 MiB. A minimal Nginx server block:

```nginx
server {
    listen 443 ssl;
    server_name silverhand.example.com;
    ssl_certificate     /etc/ssl/silverhand/fullchain.pem;
    ssl_certificate_key /etc/ssl/silverhand/privkey.pem;

    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }
}
```

The public origin (`https://silverhand.example.com`) must match `SILVERHAND_ALLOWED_ORIGINS`. Then check `https://silverhand.example.com/api/server/info` from outside the host.

## 5. Connect clients and agents

1. **Desktop.** Open **Settings → Connection**, enter `https://silverhand.example.com` as the address and save. Both the embedded and remote-only desktop builds can connect to a self-hosted server.
2. **iOS.** On the sign-in screen, choose **Change server** and enter the same address.
3. **Agent computers.** In the app, open **Computers → Add a computer** and run the shown command on the machine that should host agents. The command uses `npx @silverhand-ai/daemon@latest connect …`, so that machine needs Node.js 20 or newer. Install and sign in to the coding-agent CLIs you want to use, such as Claude Code or Codex, on that machine. To pin the daemon version that the command installs, set `SILVERHAND_DAEMON_NPM_SPEC` on the server, for example `@silverhand-ai/daemon@0.3.1`.

## Home Mac with Cloudflare Tunnel

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) runs a small connector, `cloudflared`, on your Mac. The connector opens outbound connections to Cloudflare, and Cloudflare serves your hostname over HTTPS. You need no public IP, no router port forwarding and no certificate. WebSockets work without extra configuration.

You need a Cloudflare account and a domain whose DNS is managed by Cloudflare. Do not use Quick Tunnels (`trycloudflare.com`): their hostname changes on every start, and the apps and agent computers store the server address.

1. **Build the server** on the Mac (step 1, native build):

   ```bash
   cargo build --release --locked --manifest-path rust/Cargo.toml --bin silverhand-backend
   mkdir -p ~/.local/lib/silverhand/current ~/silverhand-data/blobs ~/silverhand-data/logs
   install -m 755 rust/target/release/silverhand-backend ~/.local/lib/silverhand/current/
   ```

2. **Run it as a launch agent.** Save as `~/Library/LaunchAgents/com.silverhand.server.plist`, replacing `you` with your macOS user name and the origin with your hostname:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>com.silverhand.server</string>
     <key>ProgramArguments</key>
     <array><string>/Users/you/.local/lib/silverhand/current/silverhand-backend</string></array>
     <key>EnvironmentVariables</key>
     <dict>
       <key>SILVERHAND_DEPLOYMENT_PROFILE</key><string>remote-only</string>
       <key>SILVERHAND_DATABASE_PATH</key><string>/Users/you/silverhand-data/silverhand.db</string>
       <key>SILVERHAND_BLOBS_ROOT</key><string>/Users/you/silverhand-data/blobs</string>
       <key>SILVERHAND_LOG_DIR</key><string>/Users/you/silverhand-data/logs</string>
       <key>SILVERHAND_LISTEN_ADDR</key><string>127.0.0.1:8080</string>
       <key>SILVERHAND_ALLOWED_ORIGINS</key><string>https://silverhand.example.com</string>
     </dict>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>StandardErrorPath</key><string>/Users/you/silverhand-data/logs/launchd.err.log</string>
   </dict>
   </plist>
   ```

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.silverhand.server.plist
   curl -fsS http://127.0.0.1:8080/readyz
   ```

   To restart it after an upgrade, run `launchctl kickstart -k gui/$(id -u)/com.silverhand.server`. A launch agent runs while you are logged in, so enable automatic login for this user.

3. **Create the tunnel.** In the Cloudflare dashboard, go to **Networking → Tunnels → Create a tunnel**, name it and choose macOS. Run the shown install command on the Mac; it installs `cloudflared` as a service that starts at boot. Then add a **Published application** route with your hostname (for example `silverhand.example.com`) and the service URL `http://localhost:8080`. To manage the tunnel from the command line instead, see [Create a locally-managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/).

4. **Keep the Mac available.** In **System Settings → Energy**, turn on **Prevent automatic sleeping when the display is off** and **Start up automatically after a power failure**.

5. Check `https://silverhand.example.com/api/server/info` from another network, then connect clients and agents as in step 5. The agent computers can include the Mac itself.

## Upgrading

1. Build the new binary from the release you want.
2. Stop the service: `systemctl --user stop silverhand-server`.
3. Replace `~/.local/lib/silverhand/current/silverhand-backend`.
4. If the release changes the database schema, set `SILVERHAND_MIGRATE=1` in the environment file. A newer schema requires it; without it, the server refuses to start rather than upgrade silently.
5. Start the service and check `/readyz`.

Before migrating, the server copies the database's directory to a sibling `silverhand-data-backup-<timestamp>` directory, including a consistent database snapshot. Keep that backup until you have verified the upgrade: an older binary cannot open a database that has already been migrated. The server also refuses unknown or newer database versions, so a downgrade requires restoring the backup.

## Backups

Stop the server, then copy the whole data directory. That directory holds the database with its `-wal` file and the `blobs` directory. Start the server again afterwards.

Do not open the live database with an external SQLite client while the server is running.
