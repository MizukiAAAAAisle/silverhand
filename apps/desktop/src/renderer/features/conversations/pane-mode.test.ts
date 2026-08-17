import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConversationPlacementKindSchema } from '@silverhand/shared';
import type { ConversationPlacementKind } from '@silverhand/shared';
import type { ConversationPaneDescriptor } from './pane-descriptor';
import {
  paneCapabilities,
  placementOfPaneMode,
  projectConversationPaneMode,
  rosterQueryTarget,
  DEFAULT_PANE_CAPABILITIES,
  type ConversationPaneMode,
} from './pane-mode';

// #task:2039 — the pane's placement is read ONCE, here. Four dogfood findings
// came from four components each guessing it (`workspaceId === null`, the route,
// a local boolean), so the evidence this file owes is not "the DM header shows a
// face" (that is UI, untested by rule) but that the projection is:
//   1. TOTAL over the stored placement union — a placement with no pane mode must
//      land in `unsupported`, never fall through into channel chrome;
//   2. BIDIRECTIONAL — mode → placement inverts the projection, so a rule keyed
//      by placement and a rule keyed by mode (capabilities) cannot drift into two
//      different answers for the same conversation;
//   3. EXHAUSTIVE per capability — every capability is asserted in both
//      directions: what a mode grants, and which modes grant it. A new mode that
//      quietly inherits `hasRoster` fails the second half.
//   4. A READ GATE, not paint (@Cindy's review): the capability has to turn the
//      roster QUERIES off at the source. A surface that fires them and then
//      renders nothing because a pair happens to have no roster row has moved its
//      capability into the data, where the next placement with a non-empty roster
//      silently inherits channel behaviour.

function descriptor(
  over: Partial<ConversationPaneDescriptor> = {},
): ConversationPaneDescriptor {
  return {
    id: 'c-1',
    title: 'general',
    placement_kind: 'workspace',
    roster_policy: 'open',
    closed_at: null,
    archived_at: null,
    workspace_id: 'w-1',
    ...over,
  };
}

const PLACEMENTS: readonly ConversationPlacementKind[] =
  ConversationPlacementKindSchema.options;

const MODE_SAMPLES: Record<ConversationPaneMode['kind'], ConversationPaneMode> = {
  workspace_channel: { kind: 'workspace_channel', workspaceId: 'w-1' },
  direct_message: { kind: 'direct_message', counterpart: null },
  unsupported: { kind: 'unsupported', placement: 'agent_inbox' },
};
const MODE_KINDS = Object.keys(MODE_SAMPLES) as ConversationPaneMode['kind'][];

describe('projectConversationPaneMode — total over the placement union', () => {
  it('covers every stored placement kind', () => {
    // Not a loop for its own sake: the union lives in the DB schema, and a fifth
    // arm added there must show up here as a decision instead of as whatever the
    // `default` happens to do.
    for (const placement of PLACEMENTS) {
      const mode = projectConversationPaneMode(descriptor({ placement_kind: placement }));
      expect(MODE_KINDS).toContain(mode.kind);
    }
  });

  it('maps the two known shapes and nothing else', () => {
    expect(
      PLACEMENTS.map(p => [
        p,
        projectConversationPaneMode(descriptor({ placement_kind: p })).kind,
      ]),
    ).toEqual([
      ['workspace', 'workspace_channel'],
      ['direct_pair', 'direct_message'],
      ['agent_inbox', 'unsupported'],
    ]);
  });

  it('round-trips through the placement inverse', () => {
    // The bidirectional half: a mode names exactly the placement it came from,
    // which is what lets a placement-keyed rule and a mode-keyed rule agree.
    for (const placement of PLACEMENTS) {
      expect(
        placementOfPaneMode(projectConversationPaneMode(descriptor({ placement_kind: placement }))),
      ).toBe(placement);
    }
    for (const kind of MODE_KINDS) {
      const mode = MODE_SAMPLES[kind];
      expect(
        projectConversationPaneMode(
          descriptor({ placement_kind: placementOfPaneMode(mode) }),
        ).kind,
      ).toBe(kind);
    }
  });

  it('carries the workspace coordinate it was handed, including a null one', () => {
    expect(projectConversationPaneMode(descriptor())).toEqual({
      kind: 'workspace_channel',
      workspaceId: 'w-1',
    });
    expect(
      projectConversationPaneMode(descriptor({ workspace_id: null })),
    ).toEqual({ kind: 'workspace_channel', workspaceId: null });
  });

  it('carries the counterpart a pair resolved, and null when none was', () => {
    const counterpart = {
      status: 'active',
      kind: 'agent',
      id: 'a-1',
      name: 'norman',
      display_name: 'Norman',
      avatar_url: null,
      runtime: 'claude',
    } as const;
    expect(
      projectConversationPaneMode(
        descriptor({ placement_kind: 'direct_pair', workspace_id: null, counterpart }),
      ),
    ).toEqual({ kind: 'direct_message', counterpart });
    expect(
      projectConversationPaneMode(
        descriptor({ placement_kind: 'direct_pair', workspace_id: null }),
      ),
    ).toEqual({ kind: 'direct_message', counterpart: null });
  });
});

describe('paneCapabilities — every affordance, both directions', () => {
  it('states the whole capability set per mode', () => {
    expect(paneCapabilities(MODE_SAMPLES.workspace_channel)).toEqual({
      headerIdentity: 'channel_hash',
      hasRoster: true,
      workspaceScope: 'w-1',
    });
    expect(paneCapabilities(MODE_SAMPLES.direct_message)).toEqual({
      headerIdentity: 'counterpart',
      hasRoster: false,
      workspaceScope: null,
    });
    expect(paneCapabilities(MODE_SAMPLES.unsupported)).toEqual({
      headerIdentity: 'title_only',
      hasRoster: false,
      workspaceScope: null,
    });
  });

  it('grants roster surfaces to EXACTLY one mode', () => {
    // The inverse assertion, and the one that catches the failure this seam
    // exists for: a new mode inheriting the member strip / members button /
    // add-member picker by default.
    expect(MODE_KINDS.filter(k => paneCapabilities(MODE_SAMPLES[k]).hasRoster)).toEqual([
      'workspace_channel',
    ]);
  });

  it('gives each mode its own header identity — no two share one', () => {
    const identities = MODE_KINDS.map(k => paneCapabilities(MODE_SAMPLES[k]).headerIdentity);
    expect(new Set(identities).size).toBe(MODE_KINDS.length);
    expect(identities).toEqual(['channel_hash', 'counterpart', 'title_only']);
  });

  it('scopes workspace-only affordances to the workspace mode', () => {
    expect(
      MODE_KINDS.filter(k => paneCapabilities(MODE_SAMPLES[k]).workspaceScope !== null),
    ).toEqual(['workspace_channel']);
    // And a workspace mode with no coordinate withholds them too — the pane
    // paints what it was handed instead of asserting one.
    expect(
      paneCapabilities({ kind: 'workspace_channel', workspaceId: null }).workspaceScope,
    ).toBeNull();
  });
});

describe('rosterQueryTarget — the capability turns the READS off, not just the paint', () => {
  const target = (placement: ConversationPlacementKind, allowMemberEffects: boolean) =>
    rosterQueryTarget(
      paneCapabilities(projectConversationPaneMode(descriptor({ placement_kind: placement }))),
      'c-1',
      allowMemberEffects,
    );

  it('answers for every placement × membership cell', () => {
    // Two independent facts disable the read and they COMPOSE here rather than at
    // each call site: the placement having no roster, and the viewer not being a
    // member of one that does (a non-member browsing a public channel).
    expect(
      PLACEMENTS.flatMap(p => [
        [p, true, target(p, true)],
        [p, false, target(p, false)],
      ]),
    ).toEqual([
      ['workspace', true, 'c-1'],
      ['workspace', false, null],
      ['direct_pair', true, null],
      ['direct_pair', false, null],
      ['agent_inbox', true, null],
      ['agent_inbox', false, null],
    ]);
  });

  it('yields a conversation to read for EXACTLY the placement that has a roster', () => {
    expect(PLACEMENTS.filter(p => target(p, true) !== null)).toEqual(['workspace']);
  });

  it('returns the id it was handed — the gate never invents a target', () => {
    expect(rosterQueryTarget(DEFAULT_PANE_CAPABILITIES, 'c-other', true)).toBe('c-other');
  });
});

describe('DEFAULT_PANE_CAPABILITIES — a surface with no pane is unchanged', () => {
  it('is the workspace-channel answer, with no assumed coordinate', () => {
    // The context default. It has to be what every surface did BEFORE the
    // projection existed, so introducing the provider changed no behaviour; the
    // workspace is null because a coordinate must be carried, never assumed.
    expect(DEFAULT_PANE_CAPABILITIES).toEqual({
      headerIdentity: 'channel_hash',
      hasRoster: true,
      workspaceScope: null,
    });
  });
});

/** Source with comments removed, so a probe that comments a gate out cannot pass.
 *  (Only `//` that does not follow a `:` is stripped, so a `scheme://` survives.) */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
function read(relative: string): string {
  return code(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));
}

describe('the pane gates its roster reads on the capability (the wiring half)', () => {
  const viewSource = read('../../components/layout/ChannelView.tsx');
  const popoverSource = read('../../components/AgentInfoPopover.tsx');

  it('computes ONE roster target and hands it to BOTH roster reads', () => {
    // Desktop's test env is `node` (no jsdom/RTL), so the counter-example @Cindy
    // asked for — a DM mode not starting these query consumers — is asserted on
    // structure: the hooks receive the gated target, and both of them disable
    // their query AND their WS interest on `null`.
    expect(viewSource).toContain('rosterQueryTarget(');
    expect(viewSource).toContain('useChannelAgents(rosterTarget)');
    expect(viewSource).toContain('useChannelAgentRuntime(rosterTarget)');
    // The shape that shipped and the review rejected: membership alone starting
    // the reads, with the placement's capability only hiding the surfaces.
    expect(viewSource).not.toContain(
      'useChannelAgents(gate.allowMemberEffects',
    );
    expect(viewSource).not.toContain(
      'useChannelAgentRuntime(gate.allowMemberEffects',
    );
  });

  it('provides the capability once, at the pane boundary, from its own projection', () => {
    expect(viewSource).toContain('const paneCaps = paneCapabilities(paneMode)');
    expect(viewSource).toContain('<ConversationPaneCapabilitiesProvider value={paneCaps}>');
  });

  it('does not mount the management read chain where there is no roster', () => {
    // `AgentManagementActions` starts roster, runtime, conversation-ref and
    // workspace-member reads; it used to hide itself because a pair's roster
    // response came back without a row.
    expect(popoverSource).toContain('conversationId && paneCaps.hasRoster ?');
  });

  it('feeds the presence line the roster capability, not a presence-source enum', () => {
    // Presence reads Online/Offline from Availability on EVERY placement; the
    // roster only adds the `Not here` membership answer, so the popover is handed
    // `hasRoster`, never the obsolete `agentPresence` source (#task:2039).
    expect(popoverSource).toContain('hasRoster={paneCaps.hasRoster}');
    expect(popoverSource).not.toContain('paneCaps.agentPresence');
  });
});
