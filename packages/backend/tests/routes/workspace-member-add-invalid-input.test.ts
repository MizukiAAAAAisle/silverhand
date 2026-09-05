/**
 * POST /api/workspaces/:id/members — input classification contract.
 *
 * The body is a union of three object shapes tried in order: a tagged agent
 * `{ kind: "agent", agent_id }`, a human `{ kind: "human", user_id }`, and a
 * bare agent `{ agent_id }`. The first that matches wins and unknown keys are
 * stripped, so an object carrying a string `agent_id` is an agent whatever its
 * `kind` is. A body no arm accepts is rejected with a stable `{ error }` body:
 * raw validator diagnostics are not part of this endpoint's response.
 *
 * These pin two things as observable bytes rather than source comments: the
 * accept-set of that union, and the door ORDER — the membership floor answers a
 * non-member before the body is parsed, so a malformed body from a stranger is a
 * 403, never a 400 that would leak whether the input shape was even inspected.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/** The one stable rejection body, asserted as exact bytes. */
const INVALID_INPUT_BODY = '{"error":"invalid input"}';

describe('member-add input classification', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function createWorkspace(app: TestApp, name: string): Promise<string> {
    const res = await http(app).post('/api/workspaces', {
      name,
      member_agent_ids: [],
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as any).workspace.id as string;
  }

  it('malformed JSON is a 400 with exactly {"error":"invalid input"} as application/json', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'invalid-input-malformed');

    // A body that is not JSON at all. `post(path, undefined, { body })` sends
    // the raw string verbatim (the helper only stringifies a defined `body`).
    const res = await http(t).post(`/api/workspaces/${ws}/members`, undefined, {
      body: 'this is not json{',
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).toBe(INVALID_INPUT_BODY);
  });

  it('a shape-invalid object (no recognized union arm) is the same stable 400', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'invalid-input-union');

    // Well-formed JSON, but matches neither the agent nor the human arm.
    const res = await http(t).post(`/api/workspaces/${ws}/members`, {
      not_a_member_field: 'nonsense',
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.text();
    expect(body).toBe(INVALID_INPUT_BODY);
    // The rejection body carries no `issues` (and no other keys).
    expect(JSON.parse(body)).toEqual({ error: 'invalid input' });
  });

  it('the membership floor refuses a non-member before the body is parsed', async () => {
    // No permissive fixture memberships: `other` is a real fixture user but
    // holds no membership row, so the floor must answer them — even though their
    // body is malformed and would otherwise trip the 400 parse branch.
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const ws = await createWorkspace(t, 'invalid-input-floor');

    const strangerHeaders = {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('other'),
    };
    const res = await http(t).post(`/api/workspaces/${ws}/members`, undefined, {
      body: 'still not json{',
      headers: strangerHeaders,
    });

    // Floor before parse: a 403, not the 400 the malformed body would produce.
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('{"error":"forbidden"}');
  });

  // The union accept-set. Each row uses a member id that does not exist, so the
  // observable outcome names which ARM classified the body: an agent body reaches
  // agent existence (`404 agent not found`), a human body reaches user existence
  // (`404 user not found`), and only an unclassifiable body is `400 invalid
  // input`. A `kind`-discriminator reading would reject the "extra kind on an
  // agent body" rows as 400 — these lock them as agents instead.
  async function postBody(ws: string, body: unknown) {
    return http(t as TestApp).post(`/api/workspaces/${ws}/members`, body);
  }

  it('an agent body with a non-agent kind still classifies as an agent', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'classify-agent');

    // kind: "human" but no user_id → human arm fails, bare-agent accepts.
    let res = await postBody(ws, { kind: 'human', agent_id: 'no-such-agent' });
    expect(res.status).toBe(404);
    expect(JSON.parse(await res.text())).toEqual({ error: 'agent not found' });

    // An unknown tag is ignored by the bare-agent arm.
    res = await postBody(ws, { kind: 'bogus', agent_id: 'no-such-agent' });
    expect(res.status).toBe(404);
    expect(JSON.parse(await res.text())).toEqual({ error: 'agent not found' });

    // A non-string kind cannot select a tagged arm, but is stripped by bare-agent.
    res = await postBody(ws, { kind: 123, agent_id: 'no-such-agent' });
    expect(res.status).toBe(404);
    expect(JSON.parse(await res.text())).toEqual({ error: 'agent not found' });
  });

  it('a valid human body stays human even with an extra agent_id', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'classify-human');

    // The human arm is tried before bare-agent, so this is the human arm: it
    // reaches user existence (404 user not found), not the agent arm.
    const res = await postBody(ws, {
      kind: 'human',
      user_id: 'no-such-user',
      agent_id: 'no-such-agent',
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(await res.text())).toEqual({ error: 'user not found' });
  });

  // The id fields are bare `z.string()` — no `.min(1)` — so an EMPTY string is a
  // valid string and the body classifies. The empty id is then just an id no
  // member has, so it reaches existence and answers 404, never the 400 an
  // unclassifiable body earns. This is the exact wire behavior the Rust port must
  // match: an accepted-but-empty id is "not found", not "invalid input". A schema
  // that grew a non-empty constraint on either side would flip one of these to a
  // 400 and fail here.
  it('an empty agent_id classifies as an agent and is 404, never 400', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'classify-empty-agent');

    const res = await postBody(ws, { agent_id: '' });
    expect(res.status).toBe(404);
    expect(JSON.parse(await res.text())).toEqual({ error: 'agent not found' });
  });

  it('an empty human user_id classifies as a human and is 404, never 400', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'classify-empty-human');

    const res = await postBody(ws, { kind: 'human', user_id: '' });
    expect(res.status).toBe(404);
    expect(JSON.parse(await res.text())).toEqual({ error: 'user not found' });
  });
});
