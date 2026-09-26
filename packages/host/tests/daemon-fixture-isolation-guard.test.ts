import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

/**
 * #task:1596 round 3 (Cindy) — test-isolation wiring guard. The acceptance
 * target is that daemon fixtures CANNOT address the real `~/.silverhand`.
 *
 * The protected axis is what `runDaemon` can actually write: the durable agent
 * tree, including agent L1 and the per-agent L2 bundles under it. The agents
 * root is a required explicit coordinate, so an un-rooted daemon refuses
 * agent-file work instead of resolving `~/.silverhand/agents`. This
 * guard therefore pins the POSITIVE requirement — a fixture states where the
 * durable tree lives rather than relying on that refusal — via either of the
 * two remaining seams, any ONE of which is sufficient: `agentHomeRootDir`
 * (direct) or `computersRootDir` (the binding-keyed slot the frozen context
 * derives the agents root from). There is deliberately no home-dir test hook
 * left to sandbox. #task:1598 round 4's rule still holds for `daemonIdentityPath`: with
 * the sibling derivation gone, an omitted identity coordinate falls back to
 * `~/.silverhand/daemon/identity.json`.
 *
 * So this guard statically requires every `runDaemon(`/`runDaemon({` call in
 * host test sources, including subprocess fixtures, to pass an explicit durable agent
 * root AND an explicit identity coordinate in the same call expression. New
 * fixtures fail here immediately instead of leaking silently.
 */

const TEST_ROOTS = [resolve(__dirname)];

/** The guard file itself mentions runDaemon in prose; skip it. */
const SELF = resolve(__dirname, 'daemon-fixture-isolation-guard.test.ts');

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules') {
        continue;
      }
      collectTsFiles(path, out);
    } else if (name.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

function isolationViolations(source: string, filename: string): string[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const callees = new Set(['runDaemon']);
  const violations: string[] = [];
  function findAliases(node: ts.Node): void {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'runDaemon') {
      callees.add(node.name.text);
    }
    ts.forEachChild(node, findAliases);
  }
  findAliases(file);
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && callees.has(node.expression.text)) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'runDaemon'))
    ) {
      const options = node.arguments[0];
      const names = new Set<string>();
      if (options && ts.isObjectLiteralExpression(options)) {
        for (const property of options.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
            continue;
          if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            names.add(property.name.text);
        }
      }
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      for (const alternatives of [
        ['agentHomeRootDir', 'computersRootDir'],
        ['daemonIdentityPath'],
      ]) {
        if (!alternatives.some((name) => names.has(name))) {
          violations.push(
            `${filename}:${line} — runDaemon() without explicit ${alternatives.join(' | ')}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return violations;
}

describe('daemon test fixtures cannot address the real ~/.silverhand', () => {
  it.each([
    ['runDaemon ( { computersRootDir, daemonIdentityPath } )', 0],
    [
      "import { runDaemon as boot } from '../src/daemon/run.js'; boot({ agentHomeRootDir, daemonIdentityPath });",
      0,
    ],
    ['// runDaemon({})', 0],
    ['runDaemon({ /* agentHomeRootDir, daemonIdentityPath */ })', 2],
    ['runDaemon({ nested: { agentHomeRootDir, daemonIdentityPath } })', 2],
    ['runDaemon({}); runDaemon({ agentHomeRootDir, daemonIdentityPath });', 2],
    ['runDaemon(options)', 2],
    ['runDaemon({ agentHomeRootDir })', 1],
    ['runDaemon({ daemonIdentityPath })', 1],
  ])('checks only this call’s explicit coordinates: %s', (source, count) => {
    expect(isolationViolations(source, 'fixture.ts')).toHaveLength(count);
  });

  it('every runDaemon( call in test sources sandboxes the durable agent tree (agentHomeRootDir | computersRootDir) AND passes daemonIdentityPath', () => {
    const violations = TEST_ROOTS.flatMap((root) =>
      collectTsFiles(root)
        .filter((file) => file !== SELF)
        .flatMap((file) =>
          isolationViolations(readFileSync(file, 'utf-8'), relative(process.cwd(), file)),
        ),
    );
    expect(
      violations,
      `daemon fixtures must state the durable agent tree (agentHomeRootDir | computersRootDir) + pass daemonIdentityPath (whose omission still falls back to the real ~/.silverhand):\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
