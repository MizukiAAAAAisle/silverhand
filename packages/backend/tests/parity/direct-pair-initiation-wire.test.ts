import { afterEach, describe, expect, it } from 'vitest';
import { MAX_MESSAGE_CONTENT_BYTES, SendMessageInputSchema, apiPaths } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/direct-pair-initiation-wire.json' with { type: 'json' };

function requestInput(entry: any): unknown {
  switch (entry.request_case) {
    case 'content_over_limit': return { content: 'x'.repeat(MAX_MESSAGE_CONTENT_BYTES + 1) };
    case 'malformed_json': return {};
    case undefined: return entry.request;
    default: throw new Error(`unknown initiation request case ${entry.request_case}`);
  }
}

function expectedBody(entry: any): unknown {
  if (!entry.body_case) return entry.body;
  const source = fixture.find(candidate => candidate.name === entry.body_case);
  if (!source) throw new Error(`missing initiation body case ${entry.body_case}`);
  return expectedBody(source);
}

function normalize(value: any): any {
  if (!value?.message) return value;
  return {
    ...value,
    message: {
      ...value.message,
      id: 'message',
      conversation_id: 'pair',
      created_at: 77,
    },
  };
}

function seed(t: TestApp): void {
  t.ctx.db.exec(`
    INSERT INTO hosts(id,name,kind,created_at) VALUES('wire-dm-host','Host','local',1);
    INSERT INTO agents(id,name,runtime,host_id,display_name,created_by_user_id,
      session_scope,materialization_status,created_at,updated_at) VALUES
      ('agent-1','assistant','claude','wire-dm-host','Assistant','local','agent','active',1,1),
      ('agent-frame','frame','claude','wire-dm-host','Frame','local','conversation','active',1,1),
      ('agent-hidden','hidden','claude','wire-dm-host','Hidden','other','agent','active',1,1);
  `);
}

describe('direct-pair initiation wire is signed by the production TS route/schema', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('separates schema admission from the route cells the TS wire can authoritatively sign', async () => {
    let accepted = 0;
    let rejected = 0;
    for (const entry of fixture as any[]) {
      const parsed = SendMessageInputSchema.safeParse(requestInput(entry));
      expect(parsed.success, `${entry.name}: schema admission`).toBe(entry.schema_accepted);
      if (parsed.success) accepted += 1;
      else rejected += 1;

      // shiki ratified that Rust invalid-input issues need not byte-copy Zod.
      // These cells sign the production schema verdict directly; non-divergence
      // cells below still drive the real route and exact body.
      if (entry.admission_only) continue;

      t = buildTestApp({ seedAllFixtureMemberships: false });
      seed(t);
      const path = apiPaths.agentDirectMessages(entry.target);
      const response = entry.request_case === 'malformed_json'
        ? await http(t).post(path, undefined, {
            body: '{',
            headers: { 'content-type': 'application/json' },
          })
        : await http(t).post(path, requestInput(entry));
      expect(response.status, entry.name).toBe(entry.status);
      expect(normalize(await response.json()), entry.name).toEqual(expectedBody(entry));
      t.cleanup();
      t = null;
    }
    expect([accepted, rejected]).toEqual([7, 5]);
    expect(fixture).toHaveLength(12);
  });
});
