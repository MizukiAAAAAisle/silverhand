# 遗留 Workspace 本地数据恢复

本文适用于：用户在 workspace registry 迁移窗口内没有启动 Silverhand，
之后旧 Workspace 因缺少本地 registry binding 而无法启动 agent 或访问文件。

## 修复目标

修复的本质是在当前 daemon binding 对应的
`workspace-registry.json` 中恢复：

```text
<workspace_id> → <本机 workspace 绝对路径>
```

`workspace_id` 保持不变，因此原 Workspace 的服务端对话、任务和成员关系
都不需要迁移。

## 操作前确认

用户先完全退出 Silverhand，并备份：

- 原 workspace 文件夹；
- Silverhand 数据目录（未配置自定义位置时为 `~/.silverhand`）。

支持人员确认：

1. 服务端 Workspace 属于该用户；
2. 目标电脑是原 owning host；
3. 原 `workspace_id` 和本地绝对路径；
4. 当前 daemon 的 `(server_origin, host_id)`；
5. registry 中没有其他 id 占用相同路径、父路径或子路径。

支持人员随后提供：

- registry 文件的精确绝对路径；
- 保留了全部现有条目的完整 replacement JSON；
- 原 workspace 文件夹的精确绝对路径。

不要让用户自行推导 namespace、binding slug 或 `workspace_id`。

## Registry 内容

文件 schema 为：

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

如原文件已有其他 workspace 条目，replacement 必须原样保留，再加入待修复
条目。`provisioned_at` 是 schema 必填元数据，不参与路径解析。

## 用户操作

1. 确认 Silverhand 和 daemon 进程已经退出。
2. 将现有 registry 文件另存为带时间戳的备份。若文件不存在，不要自行选择
   其他 namespace。
3. 将支持人员提供的完整 JSON 保存为同目录下的新文件。
4. 验证 JSON 可解析，并将文件权限设为仅当前用户可读写（`0600`）。
5. 确保原 workspace 下存在 `.silverhand/agents` 目录。
6. 用新文件替换 registry 文件，重新启动 Silverhand。
7. 打开原 Workspace，确认文件可见，并启动一个 agent 核对 working
   directory。

如果同一 `workspace_id` 已指向其他路径、binding 不一致、存在路径冲突或
registry 无法解析，停止操作并保留原文件。

## 备选方案

如果不需要保留旧 Workspace 身份，可以新建一个不同名称的 Workspace，
在文件夹选择器中选择原 workspace 文件夹，再重新添加 agents 和成员。
该方案保留本地文件，但旧 Workspace 的服务端对话、任务和 Activity 不会
自动合并。

未经支持确认自行修改 registry、直接修改服务端 SQLite、删除
`~/.silverhand` 或 Reset Session 都不是本问题的恢复方式。
