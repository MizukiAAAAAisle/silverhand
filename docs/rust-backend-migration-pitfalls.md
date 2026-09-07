# Rust backend migration pitfalls

Durable preflight and review checklist. Keep this file short: add only a
reusable trap that has already caused a bug, false proof, or material delay.
Merge duplicates; do not record task status, commit hashes, or review history.

Every Rust migration task must link this file and copy only the relevant checks
into its acceptance boundary. Reviewers update the file when a finding is likely
to recur across lanes.

## TS admission and wire parity

| Trap | Rule / smallest useful proof |
| --- | --- |
| Rust integer range is wider than JavaScript | JSON numbers are binary64. Reuse the shared `JsSafeInteger` wire-boundary primitive; do not copy `2^53-1` or hide it behind a generic `validateValue`. Domain types add their own sign/range rules, and both inbound and outbound boundaries reject values that JavaScript cannot represent exactly. Apply this to timestamps, generations, sequence numbers, sizes, and counters. |
| Different string length units | JS `.length` counts UTF-16 code units. Do not substitute Rust scalar-value or grapheme counts for a Zod/JS cap. Keep one astral-character discriminator when the boundary matters. |
| Different trim/whitespace sets | ECMAScript `trim()` and Rust `str::trim` differ. U+FEFF and U+0085 are known discriminators; test them only when the endpoint trims. |
| Missing, `null`, and empty collapse | JSON has no `undefined`; an absent key is the wire form of “missing”. Reuse the shared algebra instead of nested `Option` or map lookups: `PatchField<T>` = optional+nullable, `RequiredPatchField<T>` = optional+non-nullable, `RequiredNullable<T>` = required+nullable, and `Forbidden` = must be absent. For `RequiredNullable`, use its `deserialize_present` helper **without** `#[serde(default)]`; otherwise missing silently becomes legal. Empty string/list is a separate product value. |
| Serde struct assumed to mean JSON object | A derived named struct also accepts a JSON sequence and binds elements positionally; `deny_unknown_fields` does not close that hole. Every closed body goes through the shared `ObjectOnly<T>` path (`ValidatedJson<T>` or `from_object_slice` for an ordering exception). Keep a value-shaped array discriminator such as `[true]` or `["name", ...]` that would otherwise reach the authority; do not add a leaf-local visitor or `Value::is_object` fork. |
| Structural and semantic faults fused | Closed JSON uses `ValidatedJson<T>`: Axum owns content type/syntax/data rejections (`415`/`400`/`422`) and stateless/request-local semantic refusal is the minimal `422 {"error":"invalid input"}`. Never serialize Garde's report or remap native Axum diagnostics into a project-wide envelope. Tests pin status, semantic body, and handler/authority zero-reach; they do **not** pin native rejection text. |
| Validator becomes a second rule authority | Serde owns shape/types/enums and strict-vs-strip unknown fields. Garde custom rules are thin delegates to one existing primitive; normalization belongs in the newtype/`TryFrom`, and state/current-row/custody legality stays in core (and is replayed under the write lock when needed). Do not copy UTF-16, ECMAScript trim, safe-integer, or domain grammar into attributes. |
| Zod/Garde internals mistaken for product API | Do not clone or freeze issue arrays, per-field error codes, paths, wording, discovery order, or “which of two invalid fields wins” unless a demonstrated public consumer requires that exact contract. Stable status plus the minimal top-level envelope (and an existing explicitly public domain code) is sufficient. Refusal ordering likewise survives only for a real consumer or concrete authority/resource boundary with a discriminator; a generic parity/security claim is not evidence. |
| Handwritten parity oracle | Read the real TS schema and call site. Add a shared TS↔Rust fixture only for a named drift-prone boundary; ordinary local admission gets a focused Rust test. |

## Routing and authentication

| Trap | Rule / smallest useful proof |
| --- | --- |
| Anonymous 401 treated as method proof | A perimeter layer can answer before method dispatch. Anonymous probes prove only that a path is guarded. Use an authenticated request plus a deliberately unregistered method→405 discriminator for shared paths. |
| TS refusal order overfit | A well-formed body is normally admitted before endpoint-specific existence or row-level ACL semantics; `400` winning a conflicting malformed-body request is accepted. A pre-body exception must identify the actual consumer, attack, or bounded resource it protects and include a discriminator that fails if the ordering is removed. Labels such as "security", "anti-enumeration", or "large upload" are insufficient by themselves. Without that evidence, use body-first admission and do not hand-write parsing merely to preserve TS `400`/`403`/`404` precedence. |
| Value-first exception claimed as native JSON behavior | Some authority-first/deferred routes must parse into `serde_json::Value` before typed admission. That irreversibly gives duplicate keys last-wins semantics and cannot preserve Axum's typed `JsonRejection` source. Document the exception and its actual status/envelope; use `ObjectOnly<T>` at the typed handoff, but never claim it restored native duplicate-key rejection. |
| Extractor limit undercuts the domain limit | Framework body limits apply to the whole envelope and may be lower than the product's file/payload cap. Prove the largest admitted payload passes and cap+1 reaches the domain refusal; do not fix it with unbounded aggregation. |
| Stream cap mistaken for a uniform 413 | A `Limited` body bounds bytes but hands a read error to the downstream handler, which may swallow it or map it to 200/400/500. Drive an oversize request with no `Content-Length` through representative real readers and assert the exact perimeter response, or state honestly that the contract is resource-bounding only. |
| Similar paths treated as aliases | Verify the endpoint registry. `POST /api/hosts` and `POST /api/hosts/claim-or-create` are distinct product routes. Never infer aliasing from handler names. |
| Leaf claims public parity while unmounted | Track component-complete and landed separately. Only the integration writer may mount and move the route ledger. |

## State, persistence, and effects

| Trap | Rule / smallest useful proof |
| --- | --- |
| Test fake mistaken for production authority | Enumerate every production `impl`/factory path. A trait consumed by handlers but implemented only under tests is a named missing dependency, not a mountable seam. |
| Fake/no-op effect used to mount | Do not mount custody, publication, cleanup, or delivery routes until the real production effect exists. Keep the route absorbed-but-unmounted and name the prerequisite. |
| Multi-leg effect proved by one success flag | Author, deliver, publish, disconnect, stop, purge, and blob cleanup each need a discriminating production-path proof. Green compilation is not completeness. |
| Post-commit effect failure returned as request failure | Once the write is durable, do not answer as if it rolled back: retries can duplicate side effects. Carry and log cleanup/effect residue instead of `let _ =`; return the committed result, and do not let one failed leg suppress independent remaining legs. |
| Adapter mints domain verdict | The write authority returns committed witnesses; core derives the verdict and binds identity/key/time to the request. Test omitted or inconsistent witness values. |
| Sealed fact paired with a second naked coordinate | Derive the effect target from the sealed fact, or bind the duplicate coordinate before any read/effect. Cross-wire an A fact with target B: it must be unrepresentable or fail without publishing, delivering, or computing B's audience. |
| Pre-lock decision treated as concurrency authority | Re-decide mutable authorization, custody, and multi-column domain invariants inside the write lock. Pre-lock checks are refusal ordering/fast rejection only. |
| Second cache/store/clock introduced locally | Reuse the process owner. A route-local cache, credential store, detector, clock, or event publisher is a new authority and needs an explicit architecture decision. |
| SQLite probe reopens by path | Derive probes from the live store/pool; owner shutdown must make the probe fail. Never create a second connection authority just for readiness. |

## Host/runtime boundaries

| Trap | Rule / smallest useful proof |
| --- | --- |
| Global shutdown substituted for per-host disconnect | Use the generation-bound live registry and disconnect exactly one host generation. Prove another host remains attached and a stale generation cannot disconnect the new one. |
| Custody disconnect queued behind ordinary commands | A post-commit disconnect must settle promptly and outrank queued business commands. Saturate/block the ordinary command queue; disconnect must neither hang nor allow that backlog to run before the generation-bound close. |
| Reconciliation substituted for exact-seat stop | Runtime cleanup uses captured host + runtime scope + runtime generation. A broad hydration/reconcile entry point is not equivalent. |
| Protocol capability guessed from local code | Check the shared command catalogue, protocol version/epoch admission, and receiver dispatcher. Add a capability/epoch only when an older admitted receiver could lack the command. |
| Deployment inferred from available shared wiring | Mode/profile must come from an explicit launcher-selected sum type. Common daemon/presence wiring does not prove Embedded; RemoteOnly must not even construct a local runtime detector. |
| Readiness marked during `prepare()` | `listen_ready` is witnessed only after a real listener is bound and handed to serve. Migration/fanout facts are marked at their actual lifecycle boundary, never because a handler was reached. |

## Delivery speed and evidence budget

| Trap | Rule / stop condition |
| --- | --- |
| Simple endpoint becomes a proof project | Reuse accepted authorities. One lifecycle E2E plus focused refusal tests is the default; do not add wrapper layers or generic abstractions without a correctness need. |
| Leaf gate runs only `--lib` | Contract tests under `crates/*/tests/` are separate integration binaries; `cargo test --lib` can leave them red while the leaf reports green. While building, run focused tests; at the stable tip run the full affected crate (including integration bins), fmt/diff-check, and cold clippy. Full-workspace gates still belong to integration unless a workspace-wide contract changed. |
| Review loops on hygiene | Only correctness, security, authority forks, missing effects, and wire drift block a fast-lane review. Record non-blocking naming/prose cleanup separately. |
| Shared validator called a code reduction without measuring it | `tokei` counts resident tests inside `src`, but that is not a license for infrastructure growth. Report three numbers separately: new shared production vocabulary, deleted route/parser branches, and test/proof code. A shared helper needs multiple real consumers or a correctness hole; do not claim LOC reduction from architectural prose when total or production code increased. |
| Large batch lost after context compaction | Make small local WIP commits and use `git log` as the durable progress ledger. Present one stable tip; do not keep the whole batch only in context. |
| Work continues without a named blocker | A fast-lane batch that misses its agreed checkpoint stops and reports the exact contract/authority blocker. It must not silently expand scope or proof surface. |

## Maintenance rule

During review, add an entry only when all three are true:

1. the failure mode can recur in another lane;
2. the rule changes an implementation or verification decision;
3. it can be stated in one compact row with a falsifier or stop condition.

Delete or merge entries when code, a compiler gate, or a stronger repository
document makes the reminder redundant.
