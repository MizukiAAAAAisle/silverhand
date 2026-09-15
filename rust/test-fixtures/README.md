# Backend regression oracles

These SQL/JSON files are independent regression inputs retained byte-for-byte when the TypeScript server was retired. Only data consumed by Rust tests was moved here. They are not a second executable backend or a migration runner.

The current migration authority is `packages/shared/src/db`; its generated projection is embedded in Rust. Startup tests replay that plan and verify its ledger, upgrade permission, backup recovery, rollback and retained business data. The retired TS `migration-baseline/schema-current.normalized.txt` is historical reference, not an assertion of the current Rust schema. Tests that need a preconstructed database use the executable schema snapshot.

The route registry is an expected compatibility surface; backend-app tests probe the actual composed router against it. Other fixtures exercise permissions, persistence, message delivery and wire contracts. Historical producer metadata describes provenance, not a command to run the removed TS package. Change expectations only alongside an intentional contract change and its production regression test.
