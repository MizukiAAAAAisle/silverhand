# Rust → TypeScript → Zod proof

This proof uses the exact representative declarations from the checked-in
`ts-rs` bindings, assembled into one explicit wire manifest, and generates Zod
3 validators with `ts-to-zod@3.15.0`. The generator's own type-equivalence gate
checks `z.infer` against each input declaration; `verify.ts` exercises accepted
and rejected runtime payloads.

Run from this directory:

```sh
pnpm install --ignore-workspace --frozen-lockfile
pnpm test
```

The single-file input is material: the current split `ts-rs` output failed the
generator's compatibility check for cross-file imports. A production pipeline
would need the Rust export manifest to emit this aggregate directly rather than
reconstructing it with an ad-hoc TypeScript concatenator.

The generated files are build artifacts. A production pipeline should check
them in and fail CI when regeneration produces a diff, so remote-only packaging
does not invoke Cargo.
