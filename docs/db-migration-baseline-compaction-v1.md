# DB Migration Baseline Compaction — v1 设计稿

> 状态:设计评审中(#task:1213)。设计=@Alice,实现=@Cindy。
> 前置:#task:1211 已查实 migration runner **不是 runtime hot-path**(ledger 门控
> 纯增量),所以本工作 **不是性能修复**;动机见 §1。

---

## 1. 背景与动机(诚实定价)

`packages/shared/src/db/migrations.ts` 现状:**50 个版本 / 2970 行**,其中
v1..v44 ≈ 2760 行,v45..v50 ≈ 170 行。大量是已被消费完的历史 DDL——bridge
表、12-step rebuild dance、为早已退役的过渡桥写的 `precondition`。

**先澄清一个被否的动机:** shiki 最初的担忧是"schema version update 时占用
时间"。#task:1211 已证伪:runner 是 `_migrations` ledger 门控的纯增量
(`migrationPlan.filter(m => !applied.has(m.version))`,`db.ts:144`),已应用的
版本在每次启动被直接跳过,**不重放**。所以压缩 **不会、也不需要** 改善启动
耗时。不拿一个已被证伪的前提来为这次改动背书。

**真实价值(maintainability,非 perf):**
1. **认知/维护负担** — 2970 行里绝大多数是死历史 DDL,首次阅读"当前 schema
   长什么样"必须在脑子里重放 44 个增量。
2. **DDD 清晰度** — 领域模型的当前真相被它的累积史淹没。一份 baseline 快照
   让"schema 现状"在一个地方可读。
3. **解析面收敛** — shared 包每次 build 都解析这 2970 行(边际成本,但非零)。

shiki 已拍板压缩:"如果可以压缩版本的话,我想从 45 开始保留"。本稿把"从 45
保留"翻译成精确的技术语义并给出可落地形态。

---

## 2. 核心思路:把 v1..v44 折叠成一条 baseline 快照

把 v1..v44 这 44 个增量迁移,替换成 **一条 version=44 的全量快照迁移**
(`up` = 重放 v1..v44 后的累积 schema DDL),删除原 v1..v44 源码;**保留
v45..v50 增量不动**。版本号 **绝不重排**——baseline 占据 44 这个号,正是让
"已应用到 v44 的库"在 ledger 里看到 44、从而 **跳过 baseline** 的关键。

> "从 45 保留"的精确含义 = **保留可执行 migration v45+**,但 **最低可升级 DB
> 版本 = baseline 版本 = 44**。两者不是同一个数。

---

## 3. floor 语义:`MIN_SUPPORTED_SCHEMA_VERSION` 28 → 44

这是全稿最 load-bearing 的判断,也是 @Cindy 与我独立收敛后修正过的点
(她初版口径严了一格写 45,见 §3.2)。

### 3.1 为什么恰好是 44(最小正确 floor)

floor 必须 **等于 baseline 版本**。逐情形验证(对照 `db.ts` runner):

| DB 状态 | `currentVersion` | floor guard(`db.ts:271`) | `applied` ledger | `pendingMigrations` | 结果 |
|---|---|---|---|---|---|
| 空库(全新) | 0,`isEmpty=true` | **跳过**(isEmpty 豁免) | `{}` | `[44(baseline), 45..50]` | 全量建到 v50 ✓ |
| 已在 v44 | 44 ≥ 44 | 放行 | `{1..44}` | `filter` 剔除 44 → `[45..50]` | **baseline 被跳过**,只跑 45..50 ✓ |
| 已在 v50 | 50 ≥ 44 | 放行 | `{1..50}` | `[]` | no-op ✓ |
| 停在 v43 | 43 < 44 | **拒绝 `schema_too_old`** | `{1..43}` | (不可达) | 必须拒 ✓ |

**v43 为什么必须拒:** 压缩前,v43 库只需增量跑 44..50,每条都是增量、安全。
压缩后,**44 不再是增量、而是全量 CREATE 快照**。若放行,`pendingMigrations`
会因 ledger 无 44 而把 baseline 当待跑项,在已有 v43 schema 的 **非空库** 上
重建已存在的表 → 破坏。所以 `currentVersion < 44` 必须 fail-closed。

**结论:`MIN_SUPPORTED_SCHEMA_VERSION = 44`。** 这不只是"不再支持老库",而是
**让 baseline 永远不可能落在非空库上的正确性边界**。floor guard(`db.ts:271`,
`!isEmpty && currentVersion < minimumSupportedVersion`)从一个"政策开关"升格为
本设计的 **安全不变量**。

### 3.2 为什么不是 45

45 会 **无谓拒绝一个本可升级的 v44 库**:v44 库 ledger 已有 44 → baseline 被
filter 跳过 → 跑 45..50 即可到 current,它 **能升、不该拒**。45 是人为更严的
cutoff,非技术必需。@Cindy 已同意修正为 44(若 shiki 出于产品策略想连 v44 也
拒,那是显式的更严选择,需单独声明,不是本设计的默认)。

### 3.3 gate(已确认)

需确认"无 < 44 的真实/测试库需要直接升级"。**已确认:** shiki 本机库在 v50;
单 operator dev,无遗留 28..43 库。对 standalone/remote 部署的策略见 §7。

---

## 4. runner 改动面:几乎为零(验证既有架构)

ledger 门控的增量 runner **已经** 天然容纳 baseline 压缩。`db.ts` 的
`runMigrations` **不需要任何逻辑改动**:

- `migrationPlan.filter(m => !applied.has(m.version))`(L144)自动跳过已应用的
  baseline。
- apply loop(L199 `if (applied.has(m.version)) continue;`)同样幂等。
- `CURRENT_SCHEMA_VERSION` 是 **派生值**(`migrations[last].version`,
  migrations.ts:2964)→ 仍是 50,自动正确。
- `latestMigrationVersion` 仍返回 50。

需要改的只有 **数据 + 一个常量**:
1. `migrations` 数组:删 v1..v44,插入一条 `{version:44, name:'baseline', up}`,
   保留 v45..v50。
2. `MIN_SUPPORTED_SCHEMA_VERSION` 28 → 44。

> 这是一个值得记下的架构肯定:**ledger 门控 + 派生 current version** 的设计,
> 让"压缩历史"变成一次纯数据操作而非 runner 手术。

### 4.1 baseline 迁移的形态约束

- **用 `CREATE TABLE`,不用 `IF NOT EXISTS`。** §3 已证 baseline 只可能落在
  isEmpty 库上;保留 fail-loud 语义,一旦不变量被破坏要响亮地炸,而不是静默
  跳过。
- **列顺序必须忠实于重放结果。** 列顺序是 schema 身份的一部分(`SELECT *`、
  无列名 `INSERT`)。若 v3 建 `T(a,b)`、v10 `ADD COLUMN c`,重放后是
  `(a,b,c)`;baseline 必须同序。→ 因此 `up` **必须机器生成**(从重放后的
  `sqlite_master` dump),**禁止手写"清理过的"DDL**。
- **`name` 的宇宙级无害分叉:** 新装库 `_migrations[44].name='baseline'`,老库
  保留原 v44 迁移名。runner 只按 `version` 判定(applied 是版本集),name 分叉
  纯 cosmetic,**不要去"修"它**(追这个没有意义)。
- FK:全新建库一般无需 `foreignKeyEscape`(FK 在 row-write 检查,非 CREATE);
  若 dump 工具不能保证建表依赖序,由实现侧决定是否加 escape——交给 @Cindy。

---

## 5. Drift guard:baseline 的派生与防漂移(本稿的设计取舍核心)

baseline 是 v1..v44 的 **派生产物**。DDD 纪律:**绝不手维护第二真相源**
(schema.rb / structure.sql 漂移正是这么来的)。问题在:压缩后 v1..v44 源码被
删,**漂移参照从哪来**?这是真实取舍,给两套自洽方案并明确推荐。

### 5.1 一次性生成(两方案共用)

压缩 PR 内(此时 v1..v44 **仍在**)跑一个提交进仓的脚本:
1. 在 fresh `:memory:` 上重放 v1..v44 → dump 规范化 schema → 即 `baseline.up`。
2. **生成时验证:** "重放 v1..v44 的 dump" == "只 apply baseline 的 dump"
   (规范化后逐字节相等)——证明 baseline 忠实。
3. **回归验证:** "重放 v1..v50" 的 end-state 与压缩前一致——压缩不得改变
   v50 终态。

规范化(normalize)定义:查 `sqlite_master` 按 `(type, name)` 排序、排除
`_migrations`、折叠空白;table/index/trigger/view 全在 `sqlite_master` 内,
故此即完整 schema 指纹。

### 5.2 方案 1 —— 派生留在 git history(**已选定;Alice 推荐 + Cindy ratify**)

把 §5.1 的 dump 落成一份冻结文件 `schema-v44.sql`(规范化 DDL)作为 baseline 的
**唯一权威 artifact**。**不保留 v1..v44 链。** 派生过程的可审计性 **由压缩 PR 的
diff 永久保存在 git**(那个 PR 同时含被删的链与生成的快照)。

- 形态对齐既有先例 `api-barrel-export-snapshot.json` /
  `endpoint-registry-snapshot.json`——golden 一次性捕获、此后静态。
- 代价:失去"每次 CI 从链重新派生"的能力。但 §5.1 的一次性验证已在压缩 PR
  里对着 **真实历史链** 跑过,且永存 git。

**推荐它的理由:** ①精确匹配本仓既有 drift-guard 先例;②真正的证明是 §5.1 那
次对真实链的验证,它已过且永存 git;③仅为重跑一个"已经过"的证明而留 2900 行
冻结代码,正是该砍的"无具名契约的兼容债"。guard 压缩后的职责 = 保护快照不被
改,方案 1 已满足。

#### 5.2.1 实现硬约束(Cindy ratify,避免伪 guard)

方案 1 落地时 **必须** 满足下面两条,否则会退化成两份真相源或 tautology:

1. **baseline SQL 只能有一个权威 artifact。** 禁止同时手维护 `schema-v44.sql`
   **和** `migrations.ts` 里一份复制粘贴的 `up` 字符串。实现取其一:生成脚本把
   `schema-v44.sql` 编译/内联成 TS 常量,或 migration 从同一生成产物 import。
   review 必须看到 **一个源 → migration 使用它 → test 守它** 的单链路。
2. **持续 guard 不得是 tautology。** 若 `baseline.up` 逐字节 == `schema-v44.sql`,
   那么"apply baseline == schema-v44.sql"近乎自证。最低要求是 **两段** 比较:
   - **(a) baseline 段:** fresh `:memory:` apply baseline → dump normalized →
     与 committed normalized baseline artifact(或其 hash)比较。抓:artifact
     被误改、SQL 不可执行。
   - **(b) 终态段:** 在上面基础上继续 apply v45..current → dump normalized →
     与 committed **current expected** dump/hash 比较。抓:v45+ 后续链 + current
     终态漂移。
   - 一次性"旧链 v1..v44 == baseline"的证明 **不进持续 CI**,只在压缩 PR 的
     §5.1 生成脚本输出里完成并在 git 留痕。

### 5.3 方案 2 —— 冻结整条历史链 fixture(paranoid,高保障)

把 v1..v44 原样搬进 **test-only** 冻结 fixture
`packages/shared/tests/fixtures/migration-history-v1-v44.ts`(冻结、永不编辑、
**不在 runtime 解析路径**),CI guard 每次重放该 fixture 并断言 == baseline
schema。

- 优:baseline 在每次 CI 被 **从头重新派生**,永远不可能被"快照与 baseline 同
  时写错"骗过。
- 劣:~2900 行冻结 test-only 代码(纯仓库体积/审美成本——非 runtime、非维护)。

### 5.4 取舍结论

**已选定方案 1**(Alice 推荐 + Cindy ratify):砍掉只因历史而存在的链,把
provenance 交给 git;CI guard 守快照不被改 + 终态不漂移(§5.2.1 两段比较)。
方案 2(冻结整条链持续重派生)被否——floor=44 后 <44 已非支持升级路径,把
2900 行历史链留在 fixture 本质仍是留死历史,风险/成本比不划算。

---

## 6. 测试数据隔离(shiki 硬 gate,不可谈判)

> shiki:"注意测试时一定要数据隔离,不要影响我正在跑的任何 db"。@Cindy 已认领
> 在 review 时强制检查。本节把它固化为 #task:1213 的 **硬验收门**。

- **所有** baseline / drift-guard / upgrade-path / 一次性链对比 / backup 测试,
  只能用 `:memory:` 或 `mkdtemp` 临时 sqlite 文件。
- **绝不** 指向 `~/.silverhand/silverhand.db`、daemon 当前 data dir、或任何会
  touch live registry/storage 的脚本。
- 涉及真实文件 backup/upgrade 的测试,必须在 tmpdir 里造 **完整 fake data dir**。
- 测试 helper 做成显式 `mkdtemp` + 独立 sqlite 文件;review 检查:无读写默认
  用户 DB、无复用 daemon data dir、无触碰 live registry。

**既有事实(强化此门):** `packages/backend/tests/db-migrations.test.ts` **已经**
是这个模式——`new Database(':memory:')` + backup 测试用
`mkdtempSync('/tmp/shmig-')`。本次只需 **保持并扩展** 该隔离,**绝不回退到
live 路径**。`docs/testing.md` 的"全新 in-memory DB 跑完所有 migration" helper
同理保持 `:memory:`。

---

## 7. 迁移步骤(压缩 PR)

1. 写生成脚本(§5.1):重放 v1..v44 → 规范化 dump → `schema-v44.sql`(baseline
   的唯一权威 artifact,§5.2.1-1);并跑 ②baseline==链、③v1..v50 end-state 回归
   两项一次性验证(留痕 git,不进持续 CI)。
2. `migrations` 数组:删 v1..v44,插入 `{version:44, name:'baseline', up}`,`up`
   **从 `schema-v44.sql` 同一产物生成/import**(禁手抄第二份,§5.2.1-1);保留
   v45..v50 原样。
3. `MIN_SUPPORTED_SCHEMA_VERSION` 28 → 44。
4. 加持续 drift-guard 测试(§5.2.1-2 **两段、非 tautology**):(a)apply baseline
   → normalized dump == committed baseline artifact/hash;(b)再 apply v45..current
   → normalized dump == committed current-expected dump/hash。
5. upgrade-path 测试(全在 `:memory:`/tmpdir):空库→50;v44 库→50 且
   **断言 baseline 被跳过**(45..50 才在 `appliedVersions`);v43 库→拒
   `schema_too_old`。
6. **审计 + 重做 `db-migrations.test.ts`(实现期发现:blast radius 远大于"审计").**
   该文件 3517 行,其中 ~2760 行是 **per-migration 历史测试**(`openDbAt(N)`,
   N<44,逐条验证 v16..v43 的迁移行为)。压缩后这些 migration 的 subject 被删,
   必须逐个 triage:
   - **删除** —— 一次性 **data-transform** 测试(如 v16 system-DM split、v21
     legacy_*_v21 staging、v23 Mode B cleanup、v26/v35/v37/v40/v42 backfill):
     它们测的是已删代码,且任何真实库早已 ≥44、数据已转换完,无可测。
   - **re-anchor(保覆盖,不丢)** —— **live-schema 不变量** 测试(trigger /
     CHECK / FK cascade / UNIQUE,如 users.name 唯一、跨命名空间唯一触发器、
     avatar CHECK 对、attachments dispatch 触发器、capability CHECK、conversation
     seq UNIQUE):这些约束仍活在 baseline 里,把锚点从 `openDbAt(N<44)` 改到
     `openDatabase(':memory:')`(=baseline+全增量的当前 schema)即可继续守。
   - **自动跟随** —— `SYNTHETIC_UPGRADE_BASE_VERSION = MIN_SUPPORTED_SCHEMA_VERSION`
     等用常量的合成升级测试,常量改后自动追到 44/45。
   - `openDbAt(N≥45)`(如 v48 测试 `openDbAt(47)`)仍可用——baseline@44 + 增量
     可达。
7. gate 全绿(shared/backend/server/host/cli typecheck + test)。

---

## 8. 改动清单(blast radius,已 grep 现读核实)

- **`packages/shared/src/db/migrations.ts`** — 删 v1..v44、插 baseline@44;
  `MIN_SUPPORTED_SCHEMA_VERSION` 28→44。`CURRENT_SCHEMA_VERSION` 派生,不改。
- **`packages/shared/src/db/baseline/schema-v44.sql`**(新)— 冻结快照(方案 1)。
- **`packages/backend/src/db.ts`** — **runner 零逻辑改动**;仅透传新常量值
  (import 已在 L14-16)。
- **`packages/backend/src/index.ts`**(L751-752)— 常量 re-export,值变、签名不变。
- **`packages/backend/tests/db-migrations.test.ts`** — 加 drift-guard +
  upgrade-path;审计删版本引用(§7.6)。
- **生成脚本**(新,如 `scripts/gen-migration-baseline.ts`)— 一次性派生 +
  ②③验证。
- `smoke.test.ts` / `materialize-reconciler.test.ts` 用全链建 in-memory DB →
  end-state 不变,预期无需改(回归覆盖)。
- 文档:本稿 + `docs/testing.md` 若提及 migration helper 需对齐。

---

## 9. 风险 / 回滚 / 重复性

- **本次压缩不碰任何用户数据** —— 只缩 migration **源码**,不跑 schema 变更。
  回滚 = `git revert`,历史链随之回来。
- **唯一对外可观察变化:** 原本可升的 schema 28..43 库现被 `schema_too_old`
  拒绝。§3.3 gate 已确认无此类库。
- **standalone/remote 策略:** 沿用既有 v28 floor 注释的语义——pre-baseline
  库须先经一个 `floor ≤ 自身版本` 的中间 release 升到 ≥44,再升当前。文档化,
  不做自动跨基线迁移(与 Rails migration squashing 同策略)。
- **可重复:** 这是可周期性执行的操作。链再次膨胀时,在新边界再快照、再抬
  floor。启发式(非硬规则):距上次 baseline 超过 ~N 个版本 / 文件超 ~M 行时
  考虑再压缩。

---

## 10. 评审状态

- **drift guard**(§5.2/§5.4)—— **已定方案 1 + §5.2.1 两条硬约束**(Alice 推荐
  + Cindy ratify)。
- **floor=44**(§3)—— Alice + Cindy 收敛;待 shiki 终拍(产品策略若想连 v44 也
  拒需显式声明)。
- **测试隔离**(§6)—— shiki 硬 gate,Cindy review 强制检查。
- **实现归属** —— @Cindy 接 runner/脚本/test 落地;Alice 设计 + review。
- 生成脚本/快照落点命名(`scripts/` vs `packages/shared/`)—— 实现细节,归
  @Cindy。
