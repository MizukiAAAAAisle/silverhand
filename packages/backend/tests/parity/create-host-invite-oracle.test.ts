import { readFileSync } from 'node:fs';

import { apiPaths, HostCreateInputSchema } from '@silverhand/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { CURRENT_DESKTOP_EPOCH_HEADERS } from '../utils/desktop-client-epoch.js';

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../../rust/crates/backend-server/src/host_runtime/fixtures/create_host_invite_parity.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as Record<string, {
  request: unknown;
  status: number;
  body: unknown;
}>;

function normalizeSuccess(body: any): unknown {
  return {
    ...body,
    host_id: '<host_id>',
    host: {
      ...body.host,
      id: '<host_id>',
      name: '<host_name>',
      created_at: 0,
      creator_user_id: '<user_id>',
    },
    connect_token: '<connect_token>',
  };
}

function inviteCount(target: TestApp): number {
  return target.ctx.db
    .prepare<[], { count: number }>(
      `SELECT count(*) AS count
         FROM hosts
        WHERE provisioning_source = 'user_invite'`,
    )
    .get()!.count;
}

describe('create host invite parity oracle', () => {
  let target: TestApp | null = null;

  afterEach(() => {
    target?.cleanup();
    target = null;
  });

  it('preserves the input order of multiple unknown keys', () => {
    const parsed = HostCreateInputSchema.safeParse(fixture.unknown_field!.request);
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      throw new Error('unknown fields unexpectedly passed validation');
    }
    expect(parsed.error.issues).toEqual(
      (fixture.unknown_field!.body as { issues: unknown[] }).issues,
    );
  });

  it('matches the shared success fixture', async () => {
    const previousSpec = process.env.SILVERHAND_DAEMON_NPM_SPEC;
    delete process.env.SILVERHAND_DAEMON_NPM_SPEC;
    try {
      target = buildTestApp();
      const token = target.ctx.authSessions.issueSession({
        userId: target.viewerUserId,
      }).userToken;
      const response = await http(target, {
        authorization: `Bearer ${token}`,
      }).post(apiPaths.hosts, fixture.success!.request);

      expect(response.status).toBe(fixture.success!.status);
      expect(normalizeSuccess(await response.json())).toEqual(
        fixture.success!.body,
      );
    } finally {
      if (previousSpec === undefined) {
        delete process.env.SILVERHAND_DAEMON_NPM_SPEC;
      } else {
        process.env.SILVERHAND_DAEMON_NPM_SPEC = previousSpec;
      }
    }
  });

  it.each([
    ['missing_session', null],
    ['invalid_session', 'Bearer invalid'],
    ['unknown_field', 'valid_session'],
  ] as const)('%s matches status/body and performs no write', async (name, authorization) => {
    target = buildTestApp();
    const headers = authorization === null
      ? CURRENT_DESKTOP_EPOCH_HEADERS
      : authorization === 'valid_session'
        ? {
            authorization: `Bearer ${target.ctx.authSessions.issueSession({
              userId: target.viewerUserId,
            }).userToken}`,
          }
        : { authorization };
    const before = inviteCount(target);
    const response = await http(target.app, headers).post(
      apiPaths.hosts,
      fixture[name]!.request,
    );

    expect(response.status).toBe(fixture[name]!.status);
    expect(await response.json()).toEqual(fixture[name]!.body);
    expect(inviteCount(target)).toBe(before);
  });
});
