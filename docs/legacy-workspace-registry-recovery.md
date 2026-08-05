# 历史记录：遗留 Workspace 本地数据恢复（已退役）

> **勿在当前版本执行本文步骤。** 本文只记录 relocation-v1 之前、workspace
> registry 仍是运行时路径权威时的人工恢复流程，供历史排障与迁移审计使用。
> 当前 workspace 是纯 control-plane 记录，没有本地路径列或 home computer；
> daemon 按 id 推导 agent-centric bundle，registry 只剩一次性 relocation 的只读
> 历史 inventory，不参与 spawn。终态见
> [`workspace-layout-relocation-v1.md`](./workspace-layout-relocation-v1.md)
> §3.1-§3.5；一次性迁移合同见该文 §5。
>
> 当前版本若 relocation preflight 失败，会在写 marker 前 fail closed、保留源数据并在
> 下次启动重试。应把启动失败窗口里恒显示的 typed code 交给支持排查；若窗口提供
> **Reveal Logs**，再一并附上日志；
> **不要**手改 `workspace-registry.json`、服务端 SQLite 或任何 marker，也不要照下文
> 创建旧 `.silverhand/agents` 目录。下文所有 imperative 都是历史流程的原文语义，
> 不是当前恢复指引。

## 历史适用条件（已失效）

该流程当时适用于：用户在 workspace registry 迁移窗口内没有启动 Silverhand，
之后旧 Workspace 因缺少本地 registry binding 而无法启动 agent 或访问文件。

## 历史修复目标（已失效）

当时修复的本质是在 daemon binding 对应的
`workspace-registry.json` 中恢复：

```text
<workspace_id> → <本机 workspace 绝对路径>
```

当时 `workspace_id` 保持不变，因此原 Workspace 的服务端对话、任务和成员关系
不需要迁移。当前 runtime 不再读取这份映射；保留此 schema 只是为了说明旧磁盘
inventory 的含义。

## 历史操作前确认（勿执行）

当时的流程要求用户先完全退出 Silverhand，并备份：

- 原 workspace 文件夹；
- Silverhand 数据目录（未配置自定义位置时为 `~/.silverhand`）。

支持人员当时需要确认：

1. 服务端 Workspace 属于该用户；
2. 目标电脑是原 owning host；
3. 原 `workspace_id` 和本地绝对路径；
4. 当前 daemon 的 `(server_origin, host_id)`；
5. registry 中没有其他 id 占用相同路径、父路径或子路径。

支持人员随后会提供：

- registry 文件的精确绝对路径；
- 保留了全部现有条目的完整 replacement JSON；
- 原 workspace 文件夹的精确绝对路径。

该流程禁止用户自行推导 namespace、binding slug 或 `workspace_id`。

## 历史 Registry 内容（仅作 schema 记录）

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

在旧流程里，如原文件已有其他 workspace 条目，replacement 必须原样保留，再加入
待修复条目。`provisioned_at` 是旧 schema 的必填元数据，不参与路径解析。

## 历史用户操作（勿执行）

以下步骤只记录旧流程，**不是当前版本的操作清单**：

1. 确认 Silverhand 和 daemon 进程已经退出。
2. 将现有 registry 文件另存为带时间戳的备份。若文件不存在，不要自行选择
   其他 namespace。
3. 将支持人员提供的完整 JSON 保存为同目录下的新文件。
4. 验证 JSON 可解析，并将文件权限设为仅当前用户可读写（`0600`）。
5. 确保原 workspace 下存在 `.silverhand/agents` 目录。
6. 用新文件替换 registry 文件，重新启动 Silverhand。
7. 打开原 Workspace，确认文件可见，并启动一个 agent 核对 working
   directory。

旧流程中，如果同一 `workspace_id` 已指向其他路径、binding 不一致、存在路径冲突或
registry 无法解析，要求停止操作并保留原文件。

## 历史备选方案（已失效）

当时如果不需要保留旧 Workspace 身份，可以新建一个不同名称的 Workspace，
在已退役的文件夹选择器中选择原 workspace 文件夹，再重新添加 agents 和成员。
该方案保留本地文件，但旧 Workspace 的服务端对话、任务和 Activity 不会自动合并。
当前创建表单已没有文件夹选择器，不能也不应复用这条流程。

在旧流程里，未经支持确认自行修改 registry、直接修改服务端 SQLite、删除
`~/.silverhand` 或 Reset Session 都不是恢复方式；当前版本同样禁止通过这些操作
绕过 relocation preflight。
