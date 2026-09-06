import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { sanitizeParsedEventForBroadcast } from '../src/runtime/event-sanitize.js';
const cases = JSON.parse(readFileSync(new URL('./fixtures/activity-input-sanitizer.json', import.meta.url), 'utf8'));
it.each(cases)('pins real TS tool input truncation: $name', ({ input, expected }) => {
  for (const kind of ['tool_call', 'tool_call_input'] as const) {
    const event = sanitizeParsedEventForBroadcast({ kind, name: 'test', toolCallId: 'test', input });
    expect('input' in event && event.input).toEqual(expected);
  }
});
