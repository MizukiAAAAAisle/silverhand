# Thread/channel create initial prompt stdin-only plan

## Status

Decision recorded on 2026-05-26. This document is the focused source of truth
for the planned CLI semantic change; the code is not implemented yet.

Current CLI behavior:

- `silverhand thread create` requires `--initial-prompt <text>`.
- `silverhand channel create` requires `--initial-prompt <text>`.
- Neither command reads stdin today.
- `@-`, `@<path>`, and bare `-` are ordinary string values today, not stdin or
  file sentinels.

## Problem

Initial prompts are usually multi-line instruction bodies, often containing
Markdown, quotes, `$`, backticks, and code blocks. Passing that body through an
argv flag is fragile and diverges from `silverhand message send`, whose message
body is already stdin-only.

The concrete failure that triggered this decision: several threads were created
with the first agent message equal to the literal string `@-`. The intended
heredoc content was written to stdin, but `thread create` ignored stdin and sent
the argv value `@-` as `initial_prompt`.

## Target Semantics

`silverhand thread create` and `silverhand channel create` should treat the
initial prompt exactly like `silverhand message send` treats a message body:

- The initial prompt body is read from stdin.
- `--initial-prompt` is removed.
- `--context-summary <text>` remains a required inline string flag.
- Stdin pre-flight matches `message send`: TTY stdin fails, empty stdin fails,
  and invalid UTF-8 fails.
- Supplying `--initial-prompt` fails loudly with
  `validation_error/flag_removed` and a heredoc / pipe migration hint.

Target call shape:

```bash
silverhand thread create \
  --title "Stage X" \
  --context-summary "Short recovery/audit summary." <<'SILVERHAND_EOF'
Initial prompt body.
It can contain "quotes", $vars, backticks, and code fences.
SILVERHAND_EOF
```

Single-line prompt body:

```bash
printf "%s" "Short initial prompt" | silverhand channel create \
  --title "New topic" \
  --context-summary "Why this channel exists."
```

## Non-goals

- Do not support `@-` as a stdin sentinel.
- Do not support `@<path>` or any implicit file-input sentinel.
- Do not support bare `-` as a stdin sentinel.
- Do not add a second stdin consumer for `--context-summary`.

The reason is deliberate: one command should have exactly one stdin body.
`@<path>` also conflicts with Silverhand's first-class `@<handle>` mention
syntax, and file input would create extra tool/file operations for a workflow
that is naturally represented by heredoc stdin.

## Before Implementation Lands

Until the CLI change is implemented, continue using the current required flag.
For multi-line current usage, capture the heredoc into a shell variable and pass
the quoted variable:

```bash
PROMPT=$(cat <<'SILVERHAND_EOF'
Initial prompt body.
SILVERHAND_EOF
)

silverhand thread create \
  --title "Stage X" \
  --context-summary "Short recovery/audit summary." \
  --initial-prompt "$PROMPT"
```

Do not use `--initial-prompt @-` before the implementation lands.

## Implementation Checklist

- CLI command help: remove `--initial-prompt` from `thread create` and
  `channel create`; document stdin for the initial prompt body.
- CLI parsing: mark `--initial-prompt` as a removed flag with replacement
  `stdin` and a heredoc / pipe hint.
- Stdin helper: share the same UTF-8, TTY, and empty-input behavior as
  `silverhand message send`.
- Backend RPC payload: keep sending `initial_prompt` to backend after the CLI
  reads stdin; backend service/routes do not need a semantic change.
- Platform prompt: update all `thread create` / `channel create` examples so
  agents stop using `--initial-prompt`.
- Docs: keep this file, `docs/cli-system.md`, and `docs/progress.md` aligned.
- Tests: cover stdin body reaches `initial_prompt`; old `--initial-prompt`
  fails with `flag_removed`; TTY/empty/invalid UTF-8 fail before the request.
