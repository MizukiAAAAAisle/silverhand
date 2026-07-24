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

如果必须保留原 Workspace 身份，可在支持人员确认后直接修复本地
`workspace-registry.json`。不要修改服务端 SQLite。

操作前必须确认：

1. 服务端 Workspace 属于提出请求的用户；
2. 目标电脑是该 Workspace 原本的 owning host；
3. 服务端 `workspace_id` 与缓存路径对应用户确认的本地文件夹；
4. 文件夹存在且已备份；
5. 当前 daemon binding 是预期的 `(server_origin, host_id)`；
6. registry 中没有其他条目占用相同路径、父路径或子路径。

支持人员根据当前 registry 内容生成一份完整 replacement JSON。不要让用户
自行计算 namespace、binding slug 或 `workspace_id`。文件保持以下形状：

```json
{
  "schema_version": 1,
  "binding": {
    "server_origin": "<confirmed-server-origin>",
    "host_id": "<confirmed-host-id>"
  },
  "workspaces": {
    "<workspace_id>": {
      "path": "<confirmed-absolute-workspace-path>",
      "provisioned_at": 1780000000000
    }
  }
}
```

如原文件已有其他 workspace 条目，replacement 必须原样保留这些条目，再
加入待修复条目。

支持人员提供：

- registry 文件的精确绝对路径；
- 合并了现有所有条目的完整 replacement JSON；
- 原 workspace 文件夹的精确绝对路径。

用户按以下步骤执行：

1. 完全退出 Silverhand，并确认 Silverhand/daemon 进程已经退出。
2. 备份原 workspace 文件夹和整个 Silverhand 数据目录。
3. 将现有 registry 文件另存为带时间戳的备份；文件不存在时保留该事实，
   不要自行选择其他 namespace。
4. 将支持人员提供的内容保存为同目录下的新文件。
5. 验证新文件是合法 JSON，权限设为仅当前用户可读写（`0600`）。
6. 确保原 workspace 下的 `.silverhand/agents` 目录存在。
7. 用新文件替换原 registry 文件，再启动 Silverhand。

replacement 必须保留其他 workspace 条目；同一 `workspace_id` 已指向其他
路径、其他 id 占用相同/父/子路径、binding 不一致或 registry 无法解析时，
停止操作，不覆盖原文件。

修复后：

1. 重启 Silverhand；
2. 确认原 Workspace 能解析到预期文件夹；
3. 启动一个 agent 并核对其 working directory；
4. 用户确认恢复前保留修复前备份。

未经支持确认自行修改 registry、直接修改服务端 SQLite、删除
`~/.silverhand` 或 Reset Session 都不是本问题的恢复方式。
