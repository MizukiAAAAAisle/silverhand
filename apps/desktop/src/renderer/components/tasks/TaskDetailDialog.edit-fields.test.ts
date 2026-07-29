import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The task detail modal edits title/content IN PLACE and PER FIELD — both are
// auto-growing textareas that save on BLUR (no Save/Cancel buttons). Several
// invariants here are data-safety / behavior decision branches, not painting,
// so they earn a fence:
//
//  1. Each inline editor submits ONLY its own field. `task edit` is
//     only-changed: an omitted field stays unchanged, but sending the other
//     field would clobber it. So a title save carries `title` alone and a
//     content save `body` alone — never a combined payload.
//  2. Title is submitted VERBATIM — the single-line invariant (trim + internal
//     whitespace collapse) is owned by `TaskTitleSchema` on the server, and the
//     read view refills from the canonical response; the renderer must NOT run
//     a second normalization (no `replace(/\s+/g, ' ')` here).
//  3. Save-on-commit is narrow: only a real change is sent; an empty title is
//     blocked (stays open) while an empty body is allowed; an in-flight write
//     dedups repeat blurs; a committed save latches so the focus-unmount blur
//     after an Enter commit can't re-submit (a failed save unlatches); and an
//     explicit Escape-cancel beats the blur that follows it (a bare early-return
//     would let that blur still save).
//  4. Keyboard is chat-composer parity: Enter saves, Shift+Enter newlines,
//     Escape cancels WITHOUT closing the Dialog (preventDefault so it doesn't
//     bubble to Radix). The IME guard sits atop the handler, so a CJK
//     candidate confirm/dismiss never fires a save/cancel.
//  5. Both fields carry an accessible name; the pencils only appear when
//     nothing is being edited; the View icon is dialog-level navigation pinned
//     to the top-right beside the close ✕, not in the status-metadata row.
//
// Desktop test env is `node` (no jsdom/RTL), so — like the sibling fences — we
// assert the source structure rather than render.

describe('TaskDetailDialog inline editor — blur-save, per-field, single-line title', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./TaskDetailDialog.tsx', import.meta.url)),
    'utf8',
  );

  /** Source slice of ONE component, so an editor-scoped ban can't be tripped
   *  (or satisfied) by an unrelated component in the same file. */
  function sliceFunctionBody(declaration: string): string {
    const start = source.indexOf(declaration);
    if (start === -1) {
      throw new Error(`could not find "${declaration}" — was it renamed?`);
    }
    const rest = source.slice(start + declaration.length);
    const nextDecl = rest.search(/\n(?:export )?function /);
    return nextDecl === -1 ? rest : rest.slice(0, nextDecl);
  }

  it('saves on blur (no Save/Cancel buttons)', () => {
    expect(source).toContain('onBlur={() => void commit()}');
    // Blur IS the commit and Escape IS the cancel, so the editor carries no
    // button of any kind. Scoped to the editor's own body rather than the file:
    // the modal now also hosts the unresolved-read panel, whose transient-tier
    // Retry is a legitimate `Button` (#task:1715).
    const editor = sliceFunctionBody('function InlineFieldEditor(');
    expect(editor).not.toContain('<Button');
    expect(editor).not.toContain('MiniIconButton');
  });

  it('a content save sends ONLY body; a title save sends ONLY title, both verbatim', () => {
    expect(source).toContain('{ taskId, title: value }');
    expect(source).toContain('{ taskId, body: value }');
  });

  it('never sends both fields in one edit (the omitted field stays unchanged)', () => {
    expect(source).not.toContain('title: value, body');
    expect(source).not.toContain('body: value, title');
  });

  it('does NOT re-normalize the title in the renderer (schema owns the single-line invariant)', () => {
    // Title is submitted verbatim; trim + whitespace collapse live in
    // TaskTitleSchema, and the read view refills from the canonical response.
    expect(source).not.toContain('replace(/\\s+/g');
  });

  it('commits only a real change; blocks an empty title but permits clearing content', () => {
    expect(source).toContain('if (value === initial)');
    expect(source).toContain('if (isTitle && value.trim().length === 0)');
    expect(source).toContain("setBlocked('empty')");
  });

  it('hard-blocks length only for the body, never the raw title (canonical length is the server’s)', () => {
    // A raw title-length reject would wrongly refuse a title whose canonical
    // (whitespace-collapsed) form is under the limit; the renderer runs no
    // second normalization, so title length is deferred to `TaskTitleSchema`.
    // The body uses the content limit directly — and the renderer references NO
    // title-max at all, so it can't re-imply title-length participation.
    expect(source).toContain('if (!isTitle && value.length > TASK_CONTENT_MAX_LEN)');
    expect(source).not.toContain('if (value.length > maxLen)');
    expect(source).not.toContain('TASK_TITLE_MAX_LEN');
  });

  it('refuses to close the modal while a field is being edited, and hides the jump then too', () => {
    // An outside-click / ✕ blurs the field (firing the save) AND asks to close;
    // closing now would unmount before the write settles and lose a failed
    // draft. The close request is refused while editing, and the jump icon is
    // hidden (its `showJump` gate requires `editingField === null`) so it can't
    // navigate away mid-edit either.
    expect(source).toContain('if (!next && editingField !== null) return;');
    expect(source).toContain(
      'const actionsVisible = open && painted !== null && editingField === null;',
    );
  });

  it('dedups an in-flight write, latches a successful save, and lets Escape beat the blur', () => {
    // A repeat blur while pending must not double-submit; a committed save
    // latches (`submittingRef`) so the focus-unmount blur that follows an Enter
    // commit can't re-submit, while a FAILED save unlatches for a retry; and
    // once Escape sets the cancel flag, the ensuing blur is a no-op.
    expect(source).toContain('if (edit.isPending) return;');
    expect(source).toContain(
      'if (cancelledRef.current || submittingRef.current) return;',
    );
    expect(source).toContain('submittingRef.current = true;');
    expect(source).toContain('submittingRef.current = false;');
    expect(source).toContain('cancelledRef.current = true;');
  });

  it('saves on Enter, newlines on Shift+Enter, cancels on Escape — all IME-guarded', () => {
    // Chat-composer parity: Enter without Shift commits (preventDefault stops
    // the newline), Shift+Enter falls through to a plain newline, Escape
    // cancels. The composition guard sits at the TOP of onKeyDown, before BOTH
    // the Enter and Escape branches, so a CJK candidate confirm/dismiss never
    // fires a save or cancel.
    expect(source).toContain("e.key === 'Enter' && !e.shiftKey");
    expect(source).toContain('e.preventDefault();');
    const compAt = source.indexOf('e.nativeEvent.isComposing');
    const enterAt = source.indexOf("e.key === 'Enter'");
    const escAt = source.indexOf("e.key === 'Escape'");
    expect(compAt).toBeGreaterThan(-1);
    expect(compAt).toBeLessThan(enterAt);
    expect(enterAt).toBeLessThan(escAt);
  });

  it('gives each inline field an accessible name', () => {
    expect(source).toContain(
      "aria-label={isTitle ? 'Task title' : 'Task description'}",
    );
  });

  it('offers a field pencil ONLY while the dialog-local write slot is free', () => {
    // The gate widened from "no field is being edited" to the whole local write
    // slot (`busy` = an editor open OR a status/assignee write in flight), so a
    // pencil can't start a definition edit that would race a metadata write —
    // `useEditTask` writes the detail cache wholesale and could land last.
    const gated = source.split('{!busy ? (').length - 1;
    expect(gated).toBe(2); // title pencil + content pencil
    expect(source).toContain(
      'const busy = editingField !== null || metaPending;',
    );
  });

  it('renders the View jump as the close ✕ twin in the corner cluster (not the metadata row)', () => {
    // shiki: 样式也要和 close 一样 — the jump consumes the SAME corner-button
    // recipe (`dialogCornerButtonClass`) and carries its own theme marker,
    // seated in DialogContent's top-right flex cluster via `cornerActions`
    // (spacing + centering come from the cluster, so no per-theme right-* / box
    // math). It is NOT a MiniIconButton size approximation, and no longer sits
    // in the status-metadata row (the chip drops its old height match).
    expect(source).toContain('dialogCornerButtonClass');
    expect(source).toContain('data-task-view-jump');
    expect(source).toContain('cornerActions=');
    // Dropped the earlier approximations: MiniIconButton size variant + pixel slot.
    expect(source).not.toContain('size="md"');
    expect(source).not.toContain('absolute right-10 top-3');
    expect(source).not.toContain('h-[18px] items-center box-border');
  });

  it('shares the forza6 poster-sticker skin with the close via one marker family', () => {
    // The twin relationship is a real cross-file coupling: DialogContent tags
    // the jump `data-task-view-jump`, and the forza6 sticker family must include
    // that marker so it gets the IDENTICAL poster skin — one `:is(...)` rule,
    // not a divergent block. Drop the marker on either side and the jump
    // silently regresses to a flat ghost beside a bold sticker close.
    const forza = readFileSync(
      fileURLToPath(
        new URL('../../styles/themes/forza6-components.css', import.meta.url),
      ),
      'utf8',
    );
    // Matched on the selector family rather than one literal string: the family
    // has since grown a generic `data-dialog-corner-action` arm (and wraps over
    // several lines), and what must hold is co-membership, not the exact text.
    const families = forza
      .replace(/\s+/g, ' ')
      .match(/:is\([^)]*\)/g)
      ?.filter(sel => sel.includes('[data-sticker-close]'));
    expect(families?.length).toBeGreaterThan(0);
    for (const family of families ?? []) {
      expect(family).toContain('[data-task-view-jump]');
    }
  });
});
