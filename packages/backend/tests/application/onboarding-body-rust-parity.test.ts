import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { AgentDto } from '@silverhand/shared';

import { onboardingBody } from '../../src/application/create-workspace.js';

// The Rust core renderer (`render_workspace_onboarding_body`) must reproduce the
// reference `onboardingBody` output byte-for-byte. This test is the SIGNER: it
// regenerates the fixture the Rust consumer byte-compares against, so the committed
// fixture can never silently drift from the production TS renderer — if the wording,
// spacing, reference-token, or inline-code escaping changes here, this test rewrites
// the fixture and the diff surfaces in review, and the Rust byte-compare fails until
// the Rust renderer is updated to match. Cases: solo (no peers), a multi-peer roster,
// and a workspace name carrying a backtick (the inline-code escape path).
const FIXTURE = fileURLToPath(
  new URL(
    '../../../../rust/crates/backend-core/tests/fixtures/onboarding-body.parity.json',
    import.meta.url,
  ),
);

function agent(name: string, runtime: AgentDto['runtime']): AgentDto {
  // `onboardingBody` reads only `name` + `runtime`.
  return { name, runtime } as unknown as AgentDto;
}

const CASES = [
  { label: 'solo', workspace: 'silverhand', recipient: agent('alice', 'opencode'), others: [] as AgentDto[] },
  {
    label: 'multi-peer',
    workspace: 'silverhand',
    recipient: agent('alice', 'opencode'),
    others: [agent('bob', 'codex'), agent('cara', 'claude')],
  },
  {
    label: 'backtick-workspace',
    workspace: 'a`b',
    recipient: agent('alice', 'opencode'),
    others: [agent('bob', 'codex')],
  },
];

describe('workspace onboarding body — Rust parity fixture', () => {
  it('the committed fixture equals the production onboardingBody output', () => {
    const regenerated = CASES.map(c => ({
      label: c.label,
      workspace: c.workspace,
      recipient: c.recipient.name,
      recipient_runtime: c.recipient.runtime,
      others: c.others.map(o => ({ handle: o.name, runtime: o.runtime })),
      body: onboardingBody(c.workspace, c.recipient, c.others),
    }));
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    // Byte-identical: the committed fixture the Rust test loads IS what the
    // production renderer emits today. If this fails, run with the regenerated
    // value written back to the fixture and update the Rust renderer to match.
    expect(committed).toEqual(regenerated);
  });
});
