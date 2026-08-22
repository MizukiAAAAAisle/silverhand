# Rust ↔ TypeScript / Zod 单一权威调研与最小验证

## 结论

Silverhand 当前最合适的第一阶段方案是：

```text
Rust wire DTO（唯一人工权威）
  → ts-rs 生成一个显式的聚合 TypeScript wire manifest
  → ts-to-zod 生成 Zod validator
  → checked-in TypeScript + Zod artifacts
```

这条路径不要求把现有 Zod 体系替换成 JSON Schema/Ajv，也不要求
remote-only 构建运行 Cargo。Rust、TypeScript 和 Zod 之间只有单向生成；
TypeScript interface 与 Zod schema 都是派生产物，不允许手工修改。

当前仓库使用 Zod `3.23.8`，因此 proof 固定使用
`ts-to-zod@3.15.0`；该版本依赖 `zod ^3.23.8`。未来整体升级 Zod 4 时，
再单独评估 `ts-to-zod` 5.x，不在本轮同时迁移。

## 为什么优先选这条路径

`ts-to-zod` 是专门把 TypeScript type/interface 生成 Zod schema 的社区工具，
并在生成阶段比较 `z.infer<generatedSchema>` 与输入类型；项目明确要求不要跳过
该 validation gate。[ts-to-zod 官方仓库](https://github.com/fabien0102/ts-to-zod)

它与已验证的 `ts-rs` 方向一致：Rust 先生成 TypeScript declaration，随后
Zod 从该 declaration 派生。`ts-rs` 官方支持 Rust struct/enum、泛型和主要
Serde 属性，并推荐在测试中导出 bindings。
[ts-rs 官方仓库](https://github.com/Aleph-Alpha/ts-rs)

因此不需要引入第二套 IDL，也不用把现有 shared/Zod 全部重写；新增 Rust-owned
wire contract 可按切片接入。

## 最小验证

proof 位于 `spikes/rust-backend/zod-proof/`，覆盖当前 #2165 vertical slice 的
四类声明：request、嵌套 response、`MessageDto`、tagged `ServerEvent`。其中
64-bit integer 的 wire 形态继续是 decimal string。

验证命令：

```sh
cd spikes/rust-backend/zod-proof
pnpm install --ignore-workspace --frozen-lockfile
pnpm test
```

实际通过的 gate：

1. `ts-to-zod` 的 generated-type compatibility check；
2. 生成文件通过严格 TypeScript 编译；
3. runtime 接受合法 request/response/event；
4. runtime 拒绝 number 形态的 message id、未知 event tag、错误 request 字段类型。

### 验证发现的真实限制

直接把当前四个分文件 `ts-rs` binding 输入 `ts-to-zod@3.15.0` 时，依赖
`MessageDto` 的 response/event 无法通过 compatibility check；独立文件可生成，
跨文件引用落成 `unknown`。聚合为一个显式 wire manifest 后，生成、类型检查和
runtime 验证全部通过。

因此生产方案必须让 Rust export manifest **直接生成一个聚合输入**；不能在
TypeScript 侧写临时 concatenator，也不能用 `--skipValidation` 绕过。对生成
Zod 中的 `z.any()` 还应设负向 gate，任何出现都必须显式批准。

## 不能过度承诺的边界

TypeScript 类型只能表达结构，不能完整承载 Zod 的 transform、preprocess、
default、refine、regex/长度等运行时语义。`ts-to-zod` 可读取部分 JSDoc format，
但这不是 Rust/Serde 语义的完整映射。

因此该路径适用于**结构型 wire contract**。领域语义校验应留在 application/domain；
迁移既有 Zod schema 前，必须先盘点 `.refine()`、`.transform()`、`.default()`、
preprocess、brand 和自定义 error semantics。存在这些能力的 contract 不能仅凭
生成结果替换现有 validator。

## 其他社区路径及判断

### Rust 直接生成 Zod

`specta-zod` 方向最直接，但 Specta 官方仍把 Zod exporter 标为 Partial，复杂类型
仍在稳定中；其文档也声明尚不适合 general-purpose production。
[Specta 官方状态](https://github.com/specta-rs/specta)

结论：不作为 foundation dependency。

### Rust → JSON Schema → Zod

`schemars` 是成熟的 Rust → JSON Schema 工具，目标就是让 schema 匹配 Serde
序列化形态，并支持 tagged/untagged enum、rename、flatten、deny unknown fields
等主要属性。[Schemars 官方文档](https://docs.rs/schemars/latest/schemars/)

但 JSON Schema → Zod 的常用 `json-schema-to-zod` 已于 2026-06-30 归档；
Zod 自带的 `z.fromJSONSchema()` 目前也明确是 experimental。
[json-schema-to-zod 官方仓库](https://github.com/stefanTerdell/json-schema-to-zod)、
[Zod JSON Schema 文档](https://zod.dev/json-schema)

结论：Schemars 可以作为未来标准 schema artifact 的候选，但当前不宜再接一个
不稳定/停止维护的 Zod converter。

### JSON Schema + Ajv

若未来愿意让新 wire contract 不再依赖 Zod，`schemars → JSON Schema → Ajv`
是成熟的跨语言方案。Ajv 可在构建期生成 standalone validator，运行时无需初始化
Ajv，适合 remote-only 预生成 artifact。
[Ajv standalone 官方文档](https://ajv.js.org/standalone.html)

结论：这是可靠的备选长期方向，但会在 shared 中引入第二种 runtime validator；
当前没有必要为了“纯粹”同时迁移现有 Zod 消费面。

## 生产 gate

首个真实 contract 接入时至少需要：

1. Rust 侧显式 export manifest，输出单一聚合 TypeScript wire 文件；
2. 固定 `ts-rs` / `ts-to-zod` / Zod 版本；
3. 禁止 `--skipValidation`，并拒绝未批准的 `z.any()`；
4. regeneration 后对 TypeScript 与 Zod artifacts 执行 clean-diff gate；
5. accepted/rejected wire fixtures 同时经过 Rust serde 与生成 Zod；
6. remote-only 只消费 checked-in artifacts，验证流程不调用 Cargo，产物不含
   backend binary、SQLite、migration 或 Rust native artifact；
7. 每个迁移 contract 先盘点现有 Zod runtime-only 能力，不能把 refine/transform
   静默降级为结构校验。

## 决策建议

采用 `ts-rs → aggregate TypeScript manifest → ts-to-zod` 作为首个真实 Rust wire
slice 的方案，但只承诺结构型 contract。先在一个现有 Zod schema 上做 parity
迁移并执行上述 gate；通过后再扩大范围。Schemars/Ajv 保留为将来需要标准 schema
artifact 或遇到 TypeScript 表达能力上限时的备选，不现在并行建设第二条生产链。
