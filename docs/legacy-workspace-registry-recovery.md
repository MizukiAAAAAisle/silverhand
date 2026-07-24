# 遗留 Workspace 本地数据恢复

本文只适用于：用户在 workspace registry 迁移窗口内没有启动
Silverhand，之后发现旧 Workspace 无法启动 agent 或访问本地文件。

## 用户自助恢复

如果只需要保留本地文件，不要求旧 Workspace 的 Silverhand
对话、任务继续挂在原 Workspace 身份下，可按以下步骤恢复：

1. 完全退出 Silverhand。
2. 分别备份：
   - 原 workspace 文件夹；
   - Silverhand 数据目录（未配置自定义位置时为 `~/.silverhand`）。
3. 安装最新版 Silverhand，重新打开应用。
4. 新建一个 Workspace，并使用不同的名称。
5. 在文件夹选择器中选择原 workspace 文件夹，不要选择其
   `.silverhand` 子目录。
6. 重新添加需要的 agents 和成员。
7. 确认原文件可见，并验证至少一个 agent 可以在新 Workspace 中启动。
8. 验证完成前保留旧 Workspace；确认恢复后可将旧 Workspace 归档。

该操作不会删除或移动所选文件夹。daemon 会验证路径、建立新的 registry
binding，并复用原 workspace 文件。重新添加相同 agent 时，已有的
`.silverhand/agents/<agent-id>` 数据会保留。

旧 Workspace 的服务端对话、任务和 Activity 不会自动合并到新 Workspace。

## 需要联系支持的情况

以下任一情况出现时，在完成备份后停止操作并联系支持：

- 必须保留旧 Workspace 身份、对话或任务；
- 原文件夹已经丢失或移动；
- 新建 Workspace 时提示 path conflict 或 invalid path；
- app data 或 registry 疑似损坏；
- 该 Workspace 曾连接多台电脑。

请提供：

- Silverhand 账号 nick；
- 旧 Workspace 名称；
- 电脑名称；
- 原 workspace 文件夹的绝对路径；
- Silverhand diagnostic bundle。

除非支持人员明确指定范围，不要发送 workspace 内容、认证 token 或整个
`~/.silverhand` 目录。

## 支持人员：保留原 Workspace 身份

如果必须保留原 Workspace 身份，不要让用户直接编辑 SQLite 或
`workspace-registry.json`。

操作前必须确认：

1. 服务端 Workspace 属于提出请求的用户；
2. 目标电脑是该 Workspace 原本的 owning host；
3. 服务端 `workspace_id` 与缓存路径对应用户确认的本地文件夹；
4. 文件夹存在且已备份；
5. 当前 daemon binding 是预期的 `(server_origin, host_id)`；
6. registry 中没有其他条目占用相同路径、父路径或子路径。

修复方式是：以确认后的本地文件夹作为 `requested_path`，对原
`workspace_id` 执行一次幂等 `workspace_provision`。该操作必须经过
daemon 正常的 `WorkspaceRegistry.provision()` 路径验证与原子持久化；
可使用经过 review 的 support build 或一次性 operator 工具调用。

修复后：

1. 重启 Silverhand；
2. 确认原 Workspace 能解析到预期文件夹；
3. 启动一个 agent 并核对其 working directory；
4. 用户确认恢复前保留修复前备份。

手工修改 registry JSON、直接修改服务端 SQLite、删除
`~/.silverhand` 或 Reset Session 都不是本问题的恢复方式。
