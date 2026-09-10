# Sidebar 顶层排序

顶层只有一个 viewer 私有顺序，list key/group 均为 `sidebar`。固定分支 ID 是 `section:starred` 和 `section:direct_messages`；普通 workspace 与 agent space 都以 `workspace:<workspace_id>` 标识。

`GET /api/sort/sidebar` 返回 `{viewer_sort}`，entries 已是服务端最终顺序。无 rank 的默认序为 Starred → Direct messages → regular workspace → agent space，实体各类按 created_at、id 升序。已有 rank 在未排名的新实体之前；同 rank 保留默认序。modes 固定 `{ "": "manual" }`，不得再套用 recent sorter。

`PUT /api/sort/order` 提交 `{list_key:"sidebar", group:"sidebar", ordered_ids:[...]}`，必须包含读面完整集合，包括当前为空或隐藏的固定分支。事务内重读可见、未归档 workspace 集合；重复、缺失、未知或已撤权 ID 返回409，客户端重读后重新协调拖动，不盲重试旧完整列表。同集合并发写入沿现有串行事务最后提交生效。touch/mode拒绝，不更新访问时间或切回recent。

成功提交后，当前 viewer scope 收到 `sidebar_sort_changed` 空payload hint，读取权限与顺序不由通知携带。收到hint、WS重连、workspace可见性变化时重新GET；失败不发布hint。通知沿现有WS恢复机制，不增加持久状态机。

step98 仅删除 user_list_sort_mode/user_sort_entry 中 list_key=workspaces 的旧顶层数据。channels:*、favorites、starred_at 收藏事实和其他偏好不清。旧 workspaces mutation 返回410；公开 WorkspaceListResponse 的必需 viewer_sort 字段保留为空退休投影，不再读取旧排序表。

新读写由 Rust server 实现。参考 TS server 对 sidebar 显式501，旧workspaces写入同样410，不能把新key误当channels。旧客户端不会消费新的完整混排读面；本次不自行调整API epoch或部署。
