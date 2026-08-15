import { describe, expect, it } from 'vitest';
import {
  buildPlatformPrompt,
  type PlatformPromptInput,
} from '@silverhand/shared';
import { COMMAND_GROUPS } from '../src/commands/index.js';
import {
  facetHelp,
  facetVerbHelp,
  nounHelp,
  topLevelHelp,
  verbHelp,
} from '../src/help.js';
import {
  GLOBAL_NOOP_FLAGS,
  GLOBAL_REMOVED_FLAGS,
} from '../src/strict-flags.js';

const FLAG_RE = /(?<![A-Za-z0-9-])--([a-z][a-z0-9-]*)/g;

function taughtFlags(text: string): Set<string> {
  return new Set([...text.matchAll(FLAG_RE)].map(match => match[1]!));
}

function recognizedFlagNames(): Set<string> {
  const recognized = new Set<string>([
    ...GLOBAL_NOOP_FLAGS,
    'help',
    'version',
  ]);
  for (const group of COMMAND_GROUPS) {
    for (const command of group.commands) {
      for (const flag of command.flags ?? []) recognized.add(flag);
      for (const flag of command.booleanFlags ?? []) {
        recognized.add(flag);
        recognized.add(`no-${flag}`);
      }
      for (const flag of Object.keys(command.removedFlags ?? {})) {
        recognized.add(flag);
      }
    }
    for (const facet of group.facets ?? []) {
      for (const command of facet.commands) {
        for (const flag of command.flags ?? []) recognized.add(flag);
        for (const flag of command.booleanFlags ?? []) {
          recognized.add(flag);
          recognized.add(`no-${flag}`);
        }
        for (const flag of Object.keys(command.removedFlags ?? {})) {
          recognized.add(flag);
        }
      }
    }
  }
  return recognized;
}

function activeFlagNames(): Set<string> {
  const active = new Set<string>([
    ...GLOBAL_NOOP_FLAGS,
    'help',
    'version',
  ]);
  for (const group of COMMAND_GROUPS) {
    for (const command of group.commands) {
      for (const flag of command.flags ?? []) active.add(flag);
      for (const flag of command.booleanFlags ?? []) {
        active.add(flag);
        active.add(`no-${flag}`);
      }
    }
    for (const facet of group.facets ?? []) {
      for (const command of facet.commands) {
        for (const flag of command.flags ?? []) active.add(flag);
        for (const flag of command.booleanFlags ?? []) {
          active.add(flag);
          active.add(`no-${flag}`);
        }
      }
    }
  }
  return active;
}

function removedFlagNames(): Set<string> {
  const removed = new Set(Object.keys(GLOBAL_REMOVED_FLAGS));
  for (const group of COMMAND_GROUPS) {
    for (const command of group.commands) {
      for (const flag of Object.keys(command.removedFlags ?? {})) {
        removed.add(flag);
      }
    }
    for (const facet of group.facets ?? []) {
      for (const command of facet.commands) {
        for (const flag of Object.keys(command.removedFlags ?? {})) {
          removed.add(flag);
        }
      }
    }
  }
  return removed;
}

function allHelpText(): string {
  const blocks = [topLevelHelp()];
  for (const group of COMMAND_GROUPS) {
    blocks.push(nounHelp(group.noun) ?? '');
    for (const command of group.commands) {
      blocks.push(verbHelp(group.noun, command.verb) ?? '');
    }
    for (const facet of group.facets ?? []) {
      blocks.push(facetHelp(group.noun, facet.facet) ?? '');
      for (const command of facet.commands) {
        blocks.push(
          facetVerbHelp(group.noun, facet.facet, command.verb) ?? '',
        );
      }
    }
  }
  return blocks.join('\n');
}

function agentPrompt(): string {
  const input: PlatformPromptInput = {
    agentId: 'agent-1',
    agentName: 'Alice',
    runtime: 'claude',
    activeProfileDir: '.',
    roleSystemPrompt: 'role',
    roleSystemPromptPath: '/tmp/system_prompt.md',
    currentMemory: { kind: 'missing' },
    memoryNotesCatalog: { entries: [], omittedCount: 0 },
    workspaceMemoryIndex: [],
    sessionContext: { kind: 'agent', computerId: 'host-1' },
  };
  return buildPlatformPrompt(input);
}

describe('prompt/help flags stay inside the shipped parser surface', () => {
  const recognized = recognizedFlagNames();

  it('every concrete flag taught by the prompt or help is recognized by the parser', () => {
    for (const [surface, text] of [
      ['platform prompt', agentPrompt()],
      ['CLI help', allHelpText()],
    ] as const) {
      const unknown = [...taughtFlags(text)]
        .filter(flag => !recognized.has(flag))
        .sort();
      expect(unknown, surface).toEqual([]);
    }
  });

  it('never teaches a removed flag as an accepted flag', () => {
    const active = activeFlagNames();
    const promptFlags = taughtFlags(agentPrompt());
    for (const flag of removedFlagNames()) {
      // A spelling may be retired on one command and valid on another (for
      // example `--conversation-id`). Only a spelling with no active parser
      // surface anywhere is globally forbidden in the platform prompt.
      if (!active.has(flag)) {
        expect(promptFlags.has(flag), `retired-only --${flag}`).toBe(false);
      }
    }

    // A command may name its own retired spelling only as negative migration
    // guidance. This catches stale-resolve teaching `--event-id` again without
    // banning `--conversation-id` from commands where it remains a live flag.
    const assertOwnRemovedMentionsAreNegative = (
      key: string,
      help: string,
      removedFlags: Readonly<Record<string, unknown>>,
    ): void => {
      for (const flag of Object.keys(removedFlags)) {
        const marker = `--${flag}`;
        const exactMarker = new RegExp(`${marker}(?![a-z0-9-])`);
        for (const line of help.split('\n').filter(value => exactMarker.test(value))) {
          expect(
            line,
            `${key} must not teach retired ${marker} as accepted`,
          ).toMatch(/\b(?:old|removed|retired|flag_removed|was supplied)\b/i);
        }
      }
    };
    for (const group of COMMAND_GROUPS) {
      for (const command of group.commands) {
        const key = `${group.noun} ${command.verb}`;
        assertOwnRemovedMentionsAreNegative(
          key,
          command.help,
          command.removedFlags ?? {},
        );
      }
      for (const facet of group.facets ?? []) {
        for (const command of facet.commands) {
          const key = `${group.noun} ${facet.facet} ${command.verb}`;
          assertOwnRemovedMentionsAreNegative(
            key,
            command.help,
            command.removedFlags ?? {},
          );
        }
      }
    }
  });
});
