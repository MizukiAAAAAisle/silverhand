/**
 * #task:2016 tripwire: `conversations.title` and `conversations.title_key` have
 * ONE production writer.
 *
 * "Two channels in a workspace cannot show the same name" is a conjunction of
 * three properties, and the UNIQUE index is only the second half of one of them:
 * it proves stored KEYS differ, never that a key means what its title says. That
 * relationship is maintained by code — `canonicalizeStoredConversationTitle`
 * folds, and `ConversationRepo` writes the branded pair — and the brand is a
 * TYPE, so it constrains the ARGUMENTS of a repository method and nothing else.
 * Raw SQL is under no obligation to call that method at all.
 *
 * So the compiler cannot see the write point this invariant actually depends on.
 * A future service that reaches for the handle and writes `UPDATE conversations
 * SET title = ?` — a bulk rename, an import, a "fix up legacy titles" chore —
 * would type-check, satisfy every CHECK constraint, satisfy the unique index
 * (which does not know `title` moved), and leave rows that DISPLAY one name and
 * ANSWER to another. The boot audit fails closed on exactly that, so the symptom
 * would be a server that stops booting some time after the commit that caused it.
 *
 * This gate is the earlier signal, and it is a fingerprint match rather than a
 * file allowlist: every production statement that writes either column is pinned
 * here BY THE COLUMNS IT WRITES, so a second write point is red even inside
 * `conversation-repo.ts`.
 *
 * ## The scanner has to cover the dialect, not today's three statements (B7)
 *
 * The first version of this gate matched `INSERT INTO conversations` and a bare
 * `UPDATE conversations`, which is the shape the repository happens to use today.
 * That is not a fence: `INSERT OR REPLACE INTO conversations`, `REPLACE INTO
 * conversations`, `UPDATE "conversations"` and `UPDATE [conversations]` are all
 * ordinary SQLite that any of us would write without a second thought, and each
 * one wrote `title` past the old scan with zero sites reported. A promise about a
 * "future service reaching for the handle" is only as good as the weakest legal
 * spelling of a write, so the grammar below is built from named dialect parts —
 * every conflict clause of INSERT, `REPLACE`, `UPDATE OR <action>`, all four
 * SQLite identifier quotings for the TABLE and for the COLUMNS, an optional
 * schema qualifier, upsert's `DO UPDATE SET`, row-value `SET (a, b) = (?, ?)`,
 * and an INSERT with no column list (which writes every column, so it is treated
 * as writing the guarded ones) — and `BYPASS_CORPUS` holds those spellings as
 * the gate's own self-test. No SQL parser is pulled in; the fingerprint pin stays
 * the review artifact.
 *
 * ## A dialect the grammar accepts is still invisible if the SOURCE hides it
 *
 * Covering the dialect is only half the fence, because the scan reads TypeScript,
 * not SQL. The round-2 escape was exactly there: a backtick-quoted COLUMN — the
 * fourth quoting, which the grammar already accepted for the table — ended the
 * statement early, because the old scan cut a statement at the first backtick on
 * the theory that a backtick could only be the end of the template literal
 * holding the SQL. `UPDATE conversations SET \x60title\x60 = ?` therefore
 * reported zero sites while `UPDATE conversations SET "title" = ?` reported one,
 * and the difference was not a fact about SQLite.
 *
 * So the source is NORMALIZED before the grammar runs, by {@link sqlText}: it
 * walks the file once, strips comments, keeps the BODY of every string and
 * template literal with `\\\x60`, `\\"`, `\\'` and `\\\\` decoded to the
 * characters they stand for, and blanks all the surrounding code except `;` and
 * newlines. Two properties fall out of that, and both are load-bearing: every
 * quoting reaches the grammar as itself, so a backtick in the text can only be
 * an identifier quote; and SQL concatenated across literals
 * (`'UPDATE conversations SET ' + 'title = ?'`) stays one statement, so
 * splitting a string is not a way out either. `;` survives as the statement
 * terminator, which is what stops one call's SQL from bleeding into the next.
 *
 * Normalizing rather than pattern-matching moves the risk from "which spellings
 * did we think of" to "does the walker lose its place", and the sensitivity test
 * below is the tripwire for that: the OTHER conversation writes in the tree have
 * to stay visible, in more than one file, or the normalizer has gone blind and
 * the pin test is vacuously green.
 *
 * ## Text this gate cannot read, it REFUSES — it never reads it as zero columns
 *
 * Normalizing raised its own escape, and a realistic one: a statement whose
 * structure is assembled at runtime. `UPDATE conversations SET ${column} = ?`
 * and `'UPDATE conversations SET ' + column + ' = ?'` have no column in the
 * source at all, so a normalizer that dropped the interpolation would hand the
 * grammar `SET = ?`, find no identifier, and report NOTHING — and "nothing" from
 * this scan is read as "no write here". SQL cannot parameterize an identifier,
 * which is precisely why interpolation shows up in structural positions (column,
 * table, ORDER BY) rather than only in values, so this is not a hypothetical
 * spelling.
 *
 * Deriving what the variable holds would mean growing a TS interpreter next to
 * the SQL grammar, so the contract is drawn the other way: a STATIC literal can
 * be fingerprinted, and a statement writing this table whose STRUCTURE is built
 * dynamically is REFUSED. {@link sqlText} marks every interpolation and every
 * literal concatenated onto a previous literal through a value — including a
 * build whose LAST fragment is the variable (`'UPDATE … SET ' + assignment;`),
 * where the mark is owed with no next literal to carry it and so is flushed at
 * the statement terminator — and a mark that
 * falls where the columns are decided — the SET clause, the INSERT column list,
 * the upsert's assignments, or anywhere before them — reports
 * {@link DYNAMIC_COLUMNS}: a name no pin carries and none may, so it is
 * unconditionally red. The remedy is the same as for any other hit: route the
 * write through the repository.
 *
 * Two limits are deliberate. A literal further along the same JS statement is
 * NOT part of the SQL above it (`prepare(sql).run(x === 'workspace' ? … )` is
 * three arguments, not a longer statement), so the mark has to fall inside the
 * clause that decides columns to count; and marks are emitted for
 * CONCATENATION, since that plus interpolation is how JS builds one string out
 * of parts. This costs the tree nothing today because no production
 * `conversations` write is assembled, and if one ever needs to be, that is a
 * decision worth the red.
 *
 * Scope: production sources only (`packages/backend/src`, `packages/shared/src`,
 * which owns the migrations), comments stripped — prose that quotes a statement
 * is not a writer. Tests are excluded by design: fault injection by direct SQL is
 * how the audit's defect classes are shown to be detectable at all, and a gate
 * that forbade it would forbid its own evidence.
 *
 * Remedy when this fires: do not add a pin to make it green again. Route the
 * write through `ConversationRepo.updateTitle` / `insertConversation`, which can
 * only be handed a `CanonicalConversationTitle`. A pin changes only when the
 * REPOSITORY's own statements change shape, and then the new fingerprint is the
 * review artifact.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCANNED_ROOTS = [
  resolve(REPO_ROOT, 'packages', 'backend', 'src'),
  resolve(REPO_ROOT, 'packages', 'shared', 'src'),
];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/** SQLite spells an identifier four ways: bare, `"x"`, `[x]` and MySQL-style
 *  backticks. `\x60` is the backtick, written as an escape so this file carries
 *  no delimiter that a template literal would end. */
const IDENTIFIER = String.raw`(?:[A-Za-z_][\w$]*|"(?:[^"]|"")*"|\[[^\]]*\]|\x60[^\x60]*\x60)`;
/** The live table under all four quotings. `\b` on the bare form is what keeps
 *  `conversations_new` out: a table rebuild writes a staging table whose title
 *  columns are carried across by `SELECT`, and its pairing is guarded by DDL the
 *  migration falsifiers assert in full (the placement arc CHECK makes `title_key`
 *  NOT NULL for a workspace row, so a rebuild cannot drop the key and stay
 *  green). What this gate is for is the write that keeps both columns legal and
 *  makes them DISAGREE. */
const TABLE = String.raw`(?:conversations\b|"conversations"|\[conversations\]|\x60conversations\x60)`;
/** `INSERT OR REPLACE` and friends. Optional, so a plain INSERT still matches. */
const CONFLICT_CLAUSE = String.raw`(?:\s+or\s+(?:abort|fail|ignore|replace|rollback))?`;
const SCHEMA_QUALIFIER = String.raw`(?:${IDENTIFIER}\s*\.\s*)?`;
const INSERT_HEAD = String.raw`\b(?:insert${CONFLICT_CLAUSE}\s+into|replace\s+into)\s+${SCHEMA_QUALIFIER}${TABLE}`;
const UPDATE_HEAD = String.raw`\bupdate${CONFLICT_CLAUSE}\s+${SCHEMA_QUALIFIER}${TABLE}`;
const WRITE_HEAD_RE = new RegExp(`(?<insert>${INSERT_HEAD})|(?<update>${UPDATE_HEAD})`, 'gi');

/** The assignments of an UPDATE, cut at the first clause that ends them so a
 *  predicate's `=` is not read as a written column. `FROM` is deliberately NOT a
 *  cut: a value containing the word would truncate the clause and could HIDE a
 *  column written after it, and this scan must fail closed, so an UPDATE-FROM
 *  ends at its WHERE like any other. */
const SET_CLAUSE_RE = /\bset\b([\s\S]*?)(?:\bwhere\b|\breturning\b|$)/i;
/** Upsert: the second half of `INSERT ... ON CONFLICT ... DO UPDATE SET ...`. */
const DO_UPDATE_RE = /\bdo\s+update\s+(set\b[\s\S]*)$/i;
const IDENTIFIER_TOKEN_RE = new RegExp(IDENTIFIER, 'g');

const TITLE_COLUMNS = new Set(['title', 'title_key']);
/** An INSERT with no column list writes every column, including both guarded
 *  ones. Reported under a name no pin will ever carry, so it is red by
 *  construction rather than invisible. */
const UNLISTED_COLUMNS = '<all: no column list>';

interface WriteSite {
  readonly file: string;
  readonly kind: 'insert' | 'update' | 'upsert';
  /** Written columns, in source order, restricted to the two under guard. */
  readonly titleColumns: readonly string[];
  /** Every written column, for the pin to be specific about the statement. */
  readonly columnCount: number;
}

function* walkSources(root: string): Generator<string> {
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const abs = join(root, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkSources(abs);
      continue;
    }
    const dot = entry.lastIndexOf('.');
    if (!SOURCE_EXTENSIONS.has(dot < 0 ? '' : entry.slice(dot))) continue;
    yield abs;
  }
}

/** Code outside a literal carries no SQL, but its `;` and its line breaks do
 *  carry structure, so those two survive and everything else becomes a space. */
function blankCode(text: string): string {
  return text.replace(/[^\s;]/g, ' ');
}

const QUOTES = new Set(['"', "'", '\x60']);
/** Escapes worth decoding: the three quote characters and the backslash itself.
 *  A `\x60` inside a template literal is the only legal way to write a backtick
 *  column name there, so decoding it is what makes that spelling visible at all;
 *  any other escape becomes a space, which SQL reads as whitespace. */
const DECODED_ESCAPES = new Set(['"', "'", '\x60', '\\']);

/** Marks a place where the SQL text was BUILT rather than written: a template
 *  interpolation, or a non-literal fragment concatenated between two literals.
 *  It has to survive normalization as something the grammar cannot read as an
 *  identifier, because its whole job is to make the statement unreadable. */
const DYNAMIC_MARK = ' <?> ';
/** Reported instead of columns when a guarded statement was built at runtime.
 *  Like {@link UNLISTED_COLUMNS} this is a name no pin will ever carry. */
const DYNAMIC_COLUMNS = '<dynamic-sql>';
/** What makes a fragment between two literals a VALUE rather than punctuation.
 *  `'a' + 'b'` is one string spelled twice; `'a' + x + 'b'` is a build. */
const VALUE_FRAGMENT_RE = /[A-Za-z0-9_$.\]]/;
/** ...and what makes two literals ONE string rather than two expressions. Only
 *  concatenation joins them; `run('a', x, 'b')` passes three arguments and its
 *  literals are not part of the statement above it. */
const CONCATENATION_RE = /\+|\.concat\b/;

/**
 * A source file as the SQL text this gate reads: comments gone, literal bodies
 * kept with their escapes decoded, every built fragment replaced by
 * {@link DYNAMIC_MARK}, and the code between literals blanked down to `;` and
 * newlines. See the header for why this is a walk rather than a set of patterns.
 */
export function sqlText(source: string): string {
  const out: string[] = [];
  let at = 0;
  // Whether the previous thing emitted was a literal, and the code seen since —
  // together they answer "was something concatenated in here".
  let afterLiteral = false;
  let codeSinceLiteral = '';
  // Whether a value was concatenated onto the last literal — the mark is owed
  // whether or not another literal ever arrives to carry it.
  const pendingBuild = (): boolean =>
    afterLiteral &&
    CONCATENATION_RE.test(codeSinceLiteral) &&
    VALUE_FRAGMENT_RE.test(codeSinceLiteral);
  const emitCode = (text: string): void => {
    const blanked = blankCode(text);
    const cut = blanked.indexOf(';');
    if (cut < 0) {
      out.push(blanked);
      codeSinceLiteral += text;
      return;
    }
    // A build whose last fragment is the variable — `'UPDATE … SET ' + assignment;`
    // — has no following literal, so the mark is flushed here, BEFORE the `;`,
    // which is the only place still inside the statement.
    codeSinceLiteral += text.slice(0, cut);
    if (pendingBuild()) out.push(DYNAMIC_MARK);
    out.push(blanked);
    afterLiteral = false;
    codeSinceLiteral = '';
  };
  // A comment is not SQL text and not a concatenation: it contributes neither a
  // statement terminator (a `;` in prose must not cut a statement in half) nor a
  // value fragment. Only its line breaks survive.
  const emitComment = (text: string): void => {
    out.push(text.replace(/\S/g, ' '));
  };
  while (at < source.length) {
    const ch = source[at]!;
    if (ch === '/' && source[at + 1] === '/') {
      const stop = source.indexOf('\n', at);
      const end = stop < 0 ? source.length : stop;
      emitComment(source.slice(at, end));
      at = end;
      continue;
    }
    if (ch === '/' && source[at + 1] === '*') {
      const stop = source.indexOf('*/', at + 2);
      const end = stop < 0 ? source.length : stop + 2;
      emitComment(source.slice(at, end));
      at = end;
      continue;
    }
    if (!QUOTES.has(ch)) {
      emitCode(ch);
      at++;
      continue;
    }
    const template = ch === '\x60';
    let cursor = at + 1;
    const body: string[] = [];
    while (cursor < source.length) {
      const inner = source[cursor]!;
      if (inner === '\\') {
        const escaped = source[cursor + 1] ?? '';
        body.push(DECODED_ESCAPES.has(escaped) ? escaped : ' ');
        cursor += 2;
        continue;
      }
      if (inner === ch) {
        cursor++;
        break;
      }
      // An unterminated quote is a regex literal or an operator misread as a
      // literal opener; ending it at the line break keeps the walker from
      // swallowing the rest of the file.
      if (!template && inner === '\n') break;
      if (template && inner === '$' && source[cursor + 1] === '{') {
        let depth = 0;
        let scan = cursor + 1;
        for (; scan < source.length; scan++) {
          if (source[scan] === '{') depth++;
          else if (source[scan] === '}' && --depth === 0) break;
        }
        if (scan >= source.length) break;
        // An interpolation is a hole in the statement, not a value: SQL cannot
        // parameterize an identifier, so `${column}` is exactly how a column
        // name gets built. Mark it and let the caller refuse the statement.
        body.push(DYNAMIC_MARK);
        cursor = scan + 1;
        continue;
      }
      body.push(inner);
      cursor++;
    }
    // A literal reached by CONCATENATING a value onto the previous literal
    // continues a built statement, so the join carries the same mark.
    const built = pendingBuild();
    out.push(`${built ? DYNAMIC_MARK : ' '}${body.join('')} `);
    at = cursor;
    afterLiteral = true;
    codeSinceLiteral = '';
  }
  // ...and a file that ends mid-build owes the same mark.
  if (pendingBuild()) out.push(DYNAMIC_MARK);
  return out.join('');
}


function normalizeIdentifier(raw: string): string {
  const token = raw.trim();
  const quoted =
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith('[') && token.endsWith(']')) ||
    (token.startsWith('\x60') && token.endsWith('\x60'));
  const bare = quoted && token.length >= 2 ? token.slice(1, -1) : token;
  return bare.replace(/""/g, '"').toLowerCase();
}

/** The balanced `(...)` starting at `from`, or null when `from` is not `(`. */
function balancedGroup(text: string, from: number): { inner: string; end: number } | null {
  if (text[from] !== '(') return null;
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { inner: text.slice(from + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Columns assigned by a SET clause. Splits on top-level commas and reads the
 *  identifiers left of each top-level `=`, which is what makes row-value
 *  `SET (title, title_key) = (?, ?)` visible and keeps a nested `>=` or a
 *  `CAST(... )` on the right-hand side out. */
function assignedColumns(setClause: string): string[] {
  const columns: string[] = [];
  let depth = 0;
  let start = 0;
  let assigned = false;
  for (let i = 0; i < setClause.length; i++) {
    const ch = setClause[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === ',') {
      start = i + 1;
      assigned = false;
    } else if (depth === 0 && ch === '=' && !assigned) {
      assigned = true;
      const lhs = setClause.slice(start, i);
      for (const token of lhs.match(IDENTIFIER_TOKEN_RE) ?? []) {
        columns.push(normalizeIdentifier(token));
      }
    }
  }
  return columns;
}

function site(
  file: string,
  kind: WriteSite['kind'],
  columns: readonly string[],
): WriteSite {
  return {
    file,
    kind,
    titleColumns: columns.filter(
      column =>
        TITLE_COLUMNS.has(column) || column === UNLISTED_COLUMNS || column === DYNAMIC_COLUMNS,
    ),
    columnCount: columns.filter(
      column =>
        column.length > 0 && column !== UNLISTED_COLUMNS && column !== DYNAMIC_COLUMNS,
    ).length,
  };
}

/** Every write against the live table in one source text. Exported shape is the
 *  gate's unit under test: `BYPASS_CORPUS` runs through this exact function. */
export function scanWriteSites(file: string, source: string): WriteSite[] {
  const text = sqlText(source);
  const sites: WriteSite[] = [];
  for (const head of text.matchAll(WRITE_HEAD_RE)) {
    const headEnd = (head.index ?? 0) + head[0].length;
    // A statement ends at `;`. The literal's own delimiters are gone by now, so
    // a backtick here is an identifier quote and must NOT end anything.
    const rest = text.slice(headEnd);
    const stop = rest.indexOf(';');
    const statement = rest.slice(0, stop < 0 ? rest.length : stop);
    const kind: WriteSite['kind'] = head.groups?.update ? 'update' : 'insert';
    // A statement assembled at runtime cannot be fingerprinted, so it is refused
    // rather than read: `SET ${column} = ?` has no column to report, and a scan
    // that reported nothing would be reporting "no write here". The mark counts
    // where the columns are DECIDED — a literal further along the same JS
    // statement (a `.run()` argument) is not part of the SQL above it.
    const markAt = statement.indexOf(DYNAMIC_MARK.trim());
    const refused = (which: WriteSite['kind']): void => {
      sites.push(site(file, which, [DYNAMIC_COLUMNS]));
    };
    if (kind === 'update') {
      const setClause = statement.match(SET_CLAUSE_RE);
      // No SET clause at all plus a mark means the clause itself was built.
      const decidedBy = setClause
        ? (setClause.index ?? 0) + setClause[0].length
        : Number.POSITIVE_INFINITY;
      if (markAt >= 0 && markAt < decidedBy) {
        refused('update');
        continue;
      }
      const columns = setClause ? assignedColumns(setClause[1] ?? '') : [];
      if (columns.length > 0) sites.push(site(file, 'update', columns));
      continue;
    }
    const listAt = statement.search(/\S/);
    const list = listAt < 0 ? null : balancedGroup(statement, listAt);
    if (!list) {
      // `INSERT INTO conversations ${rest}` writes an unknown set of columns for
      // an unknown reason; that is not the same claim as "no column list".
      if (markAt >= 0) {
        refused('insert');
        continue;
      }
      sites.push(site(file, 'insert', [UNLISTED_COLUMNS]));
      continue;
    }
    if (markAt >= 0 && markAt < list.end) {
      refused('insert');
      continue;
    }
    sites.push(
      site(
        file,
        'insert',
        list.inner
          .split(',')
          .map(normalizeIdentifier)
          .filter(column => column.length > 0),
      ),
    );
    // The upsert clause is read from the tail, and a mark ends what is readable
    // there: `DO UPDATE SET title = ?` followed by a built fragment is a clause
    // whose assignments this scan cannot enumerate.
    const tail = statement.slice(list.end);
    const cut = tail.indexOf(DYNAMIC_MARK.trim());
    const upsert = (cut < 0 ? tail : tail.slice(0, cut)).match(DO_UPDATE_RE);
    if (!upsert) continue;
    const clause = upsert[1] ?? '';
    const setClause = clause.match(SET_CLAUSE_RE);
    if (!setClause) continue;
    // The clause ran to the cut rather than to a WHERE/RETURNING of its own.
    if (cut >= 0 && (setClause.index ?? 0) + setClause[0].length >= clause.length) {
      refused('upsert');
      continue;
    }
    const columns = assignedColumns(setClause[1] ?? '');
    if (columns.length > 0) sites.push(site(file, 'upsert', columns));

  }
  return sites;
}

function collectWriteSites(): WriteSite[] {
  const sites: WriteSite[] = [];
  for (const root of SCANNED_ROOTS) {
    for (const abs of walkSources(root)) {
      sites.push(...scanWriteSites(relative(REPO_ROOT, abs), readFileSync(abs, 'utf8')));
    }
  }
  return sites;
}

const fingerprint = (target: WriteSite): string =>
  `${target.file} ${target.kind}(${target.columnCount}) [${target.titleColumns.join('+')}]`;

/**
 * The complete production inventory. Three statements, each with the reason its
 * shape is the shape it is — a pin without a reason is an allowlist.
 */
const PINNED_WRITE_SITES: readonly (readonly [string, string])[] = [
  [
    'packages/backend/src/repos/conversation-repo.ts insert(14) [title]',
    'getOrCreateDirectPair. Writes `title` ALONE and that is correct: a '
      + 'DirectPair holds no address, the placement arc CHECK forces its '
      + '`title_key` to stay NULL, and the stored title is a fixed constant no '
      + 'user edits. It is pinned rather than exempted so that adding `title_key` '
      + 'here — which would give a DM a workspace address — is red.',
  ],
  [
    'packages/backend/src/repos/conversation-repo.ts insert(14) [title+title_key]',
    'insertConversation, the terminal creator. Both columns come from one '
      + '`CanonicalConversationTitle` (or are `title = AGENT_INBOX_TITLE`, '
      + '`title_key = NULL` for an inbox), so they cannot disagree.',
  ],
  [
    'packages/backend/src/repos/conversation-repo.ts update(3) [title+title_key]',
    'updateTitle, the terminal renamer. The pair moves together in one '
      + 'statement; there is no window in which the row shows the new name and '
      + 'answers to the old key.',
  ],
];

/**
 * Legal SQLite spellings of a bypass. Every one of these wrote a guarded column
 * past the first version of this scan; each is here as `[sql, expected
 * fingerprint tails]` so a future narrowing of the grammar fails HERE, next to
 * the reason, rather than silently reporting zero sites in the repository.
 */
const BYPASS_CORPUS: readonly (readonly [string, readonly string[]])[] = [
  ['INSERT OR REPLACE INTO conversations (id, title) VALUES (?, ?)', ['insert(2) [title]']],
  ['INSERT OR IGNORE INTO conversations (id, title_key) VALUES (?, ?)', ['insert(2) [title_key]']],
  ['REPLACE INTO conversations (id, title, title_key) VALUES (?, ?, ?)', ['insert(3) [title+title_key]']],
  ['UPDATE "conversations" SET title = ? WHERE id = ?', ['update(1) [title]']],
  ['UPDATE [conversations] SET title = ? WHERE id = ?', ['update(1) [title]']],
  ['UPDATE \x60conversations\x60 SET title = ? WHERE id = ?', ['update(1) [title]']],
  ['UPDATE OR REPLACE conversations SET title_key = ? WHERE id = ?', ['update(1) [title_key]']],
  ['UPDATE main.conversations SET title = ? WHERE id = ?', ['update(1) [title]']],
  ['UPDATE conversations SET "title" = ?, [title_key] = ? WHERE id = ?', ['update(2) [title+title_key]']],
  // The fourth quoting, on the COLUMN. This is the round-2 escape: the old scan
  // read the first backtick as the end of the template literal and reported
  // nothing, so it is pinned here in every hosting form (see HOSTS).
  ['UPDATE conversations SET \x60title\x60 = ? WHERE id = ?', ['update(1) [title]']],
  ['UPDATE \x60main\x60.\x60conversations\x60 SET \x60title_key\x60 = ? WHERE id = ?', ['update(1) [title_key]']],
  [
    'INSERT INTO conversations (id, \x60title\x60) VALUES (?, ?) '
      + 'ON CONFLICT (id) DO UPDATE SET \x60title_key\x60 = excluded.\x60title_key\x60',
    ['insert(2) [title]', 'upsert(1) [title_key]'],
  ],
  ['UPDATE conversations SET (title, title_key) = (?, ?) WHERE id = ?', ['update(2) [title+title_key]']],
  ['UPDATE conversations SET title = ?, updated_at = CAST(? AS INTEGER) WHERE id = ?', ['update(2) [title]']],
  ['INSERT INTO conversations VALUES (?, ?, ?)', [`insert(0) [${UNLISTED_COLUMNS}]`]],
  ['INSERT INTO conversations DEFAULT VALUES', [`insert(0) [${UNLISTED_COLUMNS}]`]],
  ['INSERT INTO conversations SELECT * FROM conversations_old', [`insert(0) [${UNLISTED_COLUMNS}]`]],
  [
    // Both halves are reported: the column list is one site, `DO UPDATE SET` is
    // its own, so an upsert cannot hide a rename behind a legal INSERT.
    'INSERT INTO conversations (id, title) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET title = excluded.title',
    ['insert(2) [title]', 'upsert(1) [title]'],
  ],
];

/** Shapes the grammar must NOT report, so "covers the dialect" does not decay
 *  into "matches anything with the word conversations in it". */
const NON_WRITES: readonly string[] = [
  'INSERT INTO conversations_new (id, title, title_key) SELECT id, title, title_key FROM conversations',
  'SELECT title, title_key FROM conversations WHERE id = ?',
  'UPDATE conversation_agents SET last_read_seq = ? WHERE conversation_id = ?',
  'DELETE FROM conversations WHERE id = ?',
];

/**
 * How SQL is HOSTED in a source file. Each entry escapes one SQL string into a
 * legal TypeScript statement, and every corpus case runs through all of them:
 * which quote a developer reached for is not allowed to decide whether a write
 * is visible. The template-literal row is the one that used to lose a backtick
 * column, and the two quoted rows carry raw backticks, which is legal in both.
 */
const HOSTS: readonly (readonly [string, (sql: string) => string])[] = [
  [
    'template literal',
    sql => `const q = \x60${sql.replace(/\\/g, '\\\\').replace(/\x60/g, '\\\x60')}\x60;`,
  ],
  ['single-quoted', sql => `const q = '${sql.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}';`],
  ['double-quoted', sql => `const q = "${sql.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}";`],
];

const titleSites = (source: string): WriteSite[] =>
  scanWriteSites('probe.ts', source).filter(target => target.titleColumns.length > 0);

const shapes = (sites: readonly WriteSite[]): string[] =>
  sites.map(target => `${target.kind}(${target.columnCount}) [${target.titleColumns.join('+')}]`);

describe('conversations.title / title_key have one production writer (#task:2016)', () => {
  const sites = collectWriteSites();

  it('every production statement writing either column is a pinned repository statement', () => {
    const found = sites
      .filter(target => target.titleColumns.length > 0)
      .map(fingerprint)
      .sort();
    expect(found).toEqual(PINNED_WRITE_SITES.map(([pin]) => pin).slice().sort());
  });

  it('finds the OTHER conversation writes too, so the scan is not vacuously green', () => {
    // Sensitivity check for the gate itself. `latest_message_seq`, `archived_at`,
    // `visibility` and the endpoint-deletion triggers are written by statements
    // this scan must be able to see; a zero count would mean the grammar or the
    // roots drifted rather than that the invariant holds.
    const others = sites.filter(target => target.titleColumns.length === 0);
    expect(others.length).toBeGreaterThan(3);
    expect(others.some(target => target.file.endsWith('repos/message-repo.ts'))).toBe(true);
    expect(new Set(others.map(target => target.file)).size).toBeGreaterThan(1);
  });

  it('reports every legal SQLite spelling of a title write, in every hosting form (B7)', () => {
    for (const [sql, expected] of BYPASS_CORPUS) {
      for (const [host, wrap] of HOSTS) {
        expect(shapes(titleSites(wrap(sql))), `${host}: ${sql}`).toEqual(expected);
      }
    }
  });

  it('reads SQL concatenated across literals as one statement', () => {
    // Splitting a string is the other way to hide a column from a scan that
    // reasons per-literal, so the normalizer keeps the fragments adjacent.
    expect(
      shapes(titleSites("const q = 'UPDATE conversations SET ' + 'title = ?' + ' WHERE id = ?';")),
    ).toEqual(['update(1) [title]']);
    // ...and `;` still ends a statement, so the next call's columns are its own.
    expect(shapes(titleSites("const a = 'UPDATE conversations SET x = ?';\nconst b = 'title = ?';")))
      .toEqual([]);
  });

  it('refuses a statement built at runtime instead of reading zero columns', () => {
    // SQL cannot parameterize an identifier, so an interpolation is exactly how
    // a column, a table or an ORDER gets built. Deriving the variable's value is
    // not this gate's job; reporting the statement is. Both spellings land on a
    // name no pin carries, so either one is red.
    const interpolated = 'const column = \x27title\x27;\n'
      + 'const q = \x60UPDATE conversations SET ${column} = ? WHERE id = ?\x60;';
    expect(shapes(titleSites(interpolated))).toEqual([`update(0) [${DYNAMIC_COLUMNS}]`]);
    const concatenated = "const column = 'title';\n"
      + "const q = 'UPDATE conversations SET ' + column + ' = ? WHERE id = ?';";
    expect(shapes(titleSites(concatenated))).toEqual([`update(0) [${DYNAMIC_COLUMNS}]`]);
    // An INSERT's column list is the same hole.
    const built = 'const cols = \x27id, title\x27;\n'
      + 'const q = \x60INSERT INTO conversations (${cols}) VALUES (?, ?)\x60;';
    expect(shapes(titleSites(built))).toEqual([`insert(0) [${DYNAMIC_COLUMNS}]`]);
    // ...as is an upsert whose assignments continue past a built fragment.
    const upsert = 'const extra = \x27, title_key = ?\x27;\n'
      + 'const q = \x60INSERT INTO conversations (id, title) VALUES (?, ?)\n'
      + '  ON CONFLICT (id) DO UPDATE SET title = ? ${extra}\x60;';
    expect(shapes(titleSites(upsert)))
      .toEqual(['insert(2) [title]', `upsert(0) [${DYNAMIC_COLUMNS}]`]);
    expect(PINNED_WRITE_SITES.some(([pin]) => pin.includes(DYNAMIC_COLUMNS))).toBe(false);
  });

  it('refuses a build whose last fragment is the variable', () => {
    // The mark is owed at the join, but a trailing fragment has no next literal
    // to carry it, so it is flushed at the statement terminator instead — one `;`
    // earlier and the statement reads `SET` with nothing assigned.
    const tail = "const assignment = 'title = ?';\n"
      + "const q = 'UPDATE conversations SET ' + assignment;";
    expect(shapes(titleSites(tail))).toEqual([`update(0) [${DYNAMIC_COLUMNS}]`]);
    const concat = "const assignment = 'title = ?';\n"
      + "const q = 'UPDATE conversations SET '.concat(assignment);";
    expect(shapes(titleSites(concat))).toEqual([`update(0) [${DYNAMIC_COLUMNS}]`]);
    // ...including at end of file, where there is no terminator either.
    expect(shapes(titleSites("const q = 'UPDATE conversations SET ' + assignment")))
      .toEqual([`update(0) [${DYNAMIC_COLUMNS}]`]);
  });

  it('does not mistake a later argument for part of the statement', () => {
    // The counterweight to the rule above: `prepare(sql).run(...)` puts more
    // literals in the same JS statement, and treating those as a continuation of
    // the SQL would refuse the repository's own pinned writes. A literal only
    // continues a statement when something concatenated it there.
    const source = 'this.db.prepare(\x60UPDATE conversations SET title = ?, title_key = ?'
      + ' WHERE id = ?\x60)\n'
      + "  .run(title, key, kind === 'workspace' ? id : null, mode ?? 'private');";
    expect(shapes(titleSites(source))).toEqual(['update(2) [title+title_key]']);
  });

  it('does not report reads, the rebuild staging table, or another table', () => {
    for (const sql of NON_WRITES) {
      for (const [host, wrap] of HOSTS) {
        expect(titleSites(wrap(sql)), `${host}: ${sql}`).toEqual([]);
      }
    }
  });

  it('reads the columns of a statement, not merely its table', () => {
    // The pins above are only meaningful if `titleColumns` is really derived from
    // the SQL, in both directions on one synthetic pair, so a grammar that
    // matched everything or nothing fails here first.
    const [pair] = scanWriteSites(
      'probe.ts',
      'const q = \x60UPDATE conversations SET title = ?, title_key = ? WHERE id = ?\x60;',
    );
    expect(pair?.titleColumns).toEqual(['title', 'title_key']);
    const [predicateOnly] = scanWriteSites(
      'probe.ts',
      'const q = \x60UPDATE conversations SET updated_at = ? WHERE title_key = ?\x60;',
    );
    expect(predicateOnly?.titleColumns).toEqual([]);
    expect(predicateOnly?.columnCount).toBe(1);
  });

  it('does not read a statement quoted in prose as a writer', () => {
    // The stripper is load-bearing in one direction only: it must not turn the
    // real statements invisible (the pin test above is that half), and prose
    // about a hypothetical write must not be a site.
    const commented = scanWriteSites(
      'probe.ts',
      '// A future chore could UPDATE conversations SET title = ? here.\n'
        + '/* or REPLACE INTO conversations (id, title) VALUES (?, ?) */\n',
    );
    expect(commented).toEqual([]);
    // ...and a comment does not swallow the statement after it.
    const afterComment = scanWriteSites(
      'probe.ts',
      '// see above\nconst q = \x60UPDATE conversations SET title = ? WHERE id = ?\x60;',
    );
    expect(afterComment.map(target => target.titleColumns)).toEqual([['title']]);
  });
});
