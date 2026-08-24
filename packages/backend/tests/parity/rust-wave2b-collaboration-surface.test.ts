import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apiPaths } from '../../../shared/src/api/paths.js';
import { internalAgentRoutePaths } from '../../src/routes/internal-agent/paths.js';
import surface from '../fixtures/rust-wave2b-collaboration-surface.json' with {
  type: 'json',
};

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Registration = {
  family: string;
  source: string;
  method: Method;
  path: string;
};

const FAMILY_COUNTS = {
  conversation: 33,
  direct_pair_initiation: 1,
  attention: 7,
  notifications: 3,
  attachments: 6,
  internal_message: 3,
  internal_reaction: 2,
  internal_file: 4,
  internal_conversation: 5,
} as const;

const ROUTE_SOURCES = [
  'routes/workspaces.ts',
  'routes/conversations.ts',
  'routes/direct-pairs.ts',
  'routes/attention.ts',
  'routes/notifications.ts',
  'routes/attachments.ts',
  'routes/internal-agent/message-routes.ts',
  'routes/internal-agent/react-routes.ts',
  'routes/internal-agent/file-routes.ts',
  'routes/internal-agent/conversation-routes.ts',
] as const;

const OUT_OF_LANE_REGISTRATIONS = new Set([
  'routes/workspaces.ts|GET|/api/workspaces',
  'routes/workspaces.ts|GET|/api/workspaces/name-availability',
  'routes/workspaces.ts|POST|/api/workspaces',
  'routes/workspaces.ts|GET|/api/workspaces/:id',
  'routes/workspaces.ts|PATCH|/api/workspaces/:id',
  'routes/workspaces.ts|PATCH|/api/workspaces/:id/archive',
  'routes/workspaces.ts|DELETE|/api/workspaces/:id',
  'routes/conversations.ts|POST|/api/channels/:id/messages',
  'routes/direct-pairs.ts|GET|/api/direct-pairs',
  'routes/internal-agent/message-routes.ts|POST|/internal/agents/:aid/send-message',
]);

function routeKey(route: Pick<Registration, 'source' | 'method' | 'path'>): string {
  return `${route.source}|${route.method}|${route.path}`;
}

function parseStringArguments(raw: string): string[] {
  const values: string[] = [];
  const matcher = /(['"])(.*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(raw)) !== null) values.push(match[2]!);
  return values;
}

function resolveExpression(expression: string): string {
  const literal = expression.match(/^(['"])(.*)\1$/s);
  if (literal) return literal[2]!;

  const helper = expression.match(
    /^(apiPaths|internalAgentRoutePaths)\.(\w+)(?:\((.*)\))?$/s,
  );
  if (!helper) throw new Error(`unsupported route expression: ${expression}`);
  const [, owner, name, rawArgs = ''] = helper;
  const table = owner === 'apiPaths' ? apiPaths : internalAgentRoutePaths;
  const value = table[name as keyof typeof table];
  if (value === undefined) throw new Error(`unknown route helper: ${owner}.${name}`);
  const localPath =
    typeof value === 'function'
      ? (value as (...args: string[]) => string)(...parseStringArguments(rawArgs))
      : value;
  return owner === 'internalAgentRoutePaths'
    ? `/internal/agents/:aid${localPath}`
    : localPath;
}

function firstArgument(source: string, start: number): string {
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') round += 1;
    else if (char === ')') round -= 1;
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === ',' && round === 0 && square === 0 && curly === 0) {
      return source.slice(start, index).replace(/\s+/g, ' ').trim();
    }
  }
  throw new Error('route registration has no first-argument terminator');
}

function sourceRegistrations(sourceName: string): Registration[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, '../../src', sourceName);
  const source = readFileSync(path, 'utf8');
  const matcher = /app\.(get|post|put|patch|delete)\s*\(/g;
  const registrations: Registration[] = [];
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(source)) !== null) {
    const expression = firstArgument(source, matcher.lastIndex);
    registrations.push({
      family: '',
      source: sourceName,
      method: match[1]!.toUpperCase() as Method,
      path: resolveExpression(expression),
    });
  }
  return registrations;
}

function sourceContains(relativePath: string, needle: string): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '../../../..');
  return readFileSync(resolve(repoRoot, relativePath), 'utf8').includes(needle);
}

describe('Rust Wave 2B collaboration surface', () => {
  it('is exactly the 64 TS registrations after governance and Wave 1 exclusions', () => {
    const all = ROUTE_SOURCES.flatMap(sourceRegistrations);
    expect(all).toHaveLength(74);
    const owned = all.filter(
      route => !OUT_OF_LANE_REGISTRATIONS.has(routeKey(route)),
    );
    expect(owned.map(routeKey).sort()).toEqual(
      (surface.routes as Registration[]).map(routeKey).sort(),
    );
  });

  it('keeps the mechanical family partition and excludes task/schedule ownership', () => {
    const actualCounts = Object.fromEntries(
      Object.keys(FAMILY_COUNTS).map(family => [
        family,
        surface.routes.filter(route => route.family === family).length,
      ]),
    );
    expect(actualCounts).toEqual(FAMILY_COUNTS);
    expect(surface.routes).toHaveLength(64);
    expect(
      surface.routes.some(
        route =>
          route.path.includes('/tasks') || route.path.includes('/schedules'),
      ),
    ).toBe(false);
  });

  it('pins the five product events to real producers, consumers and cold authorities', () => {
    expect(surface.events.map(event => event.kind).sort()).toEqual([
      'attachment_changed',
      'attention_pref_changed',
      'message_reaction_changed',
      'saved_changed',
      'workspace_channels_changed',
    ]);
    for (const event of surface.events) {
      expect(event.scope).not.toBe('');
      expect(event.cold_authorities.length).toBeGreaterThan(0);
      for (const producer of event.publisher_sources) {
        const producerSource = `packages/backend/src/${producer}`;
        expect(
          sourceContains(producerSource, event.kind) ||
            sourceContains(
              producerSource,
              `${event.kind.toUpperCase()}_EVENT`,
            ),
          `${event.kind} producer ${producer}`,
        ).toBe(true);
      }
      for (const consumer of event.consumer_sources) {
        expect(
          sourceContains(consumer, event.kind),
          `${event.kind} consumer ${consumer}`,
        ).toBe(true);
      }
    }
    expect(JSON.stringify(surface)).not.toContain('task_changed');
  });
});
