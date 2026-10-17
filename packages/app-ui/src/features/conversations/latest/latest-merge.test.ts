import { describe, expect, it } from "vitest";
import {
  applyLatestEvent,
  applyLatestSnapshot,
  type LatestEntry,
  type LatestMap,
} from "./latest-merge";

interface Entry extends LatestEntry {
  text: string;
}
const entry = (
  conversation_id: string,
  seq: number,
  text = `${conversation_id}@${seq}`,
): Entry => ({
  conversation_id,
  seq,
  text,
});
const texts = (map: LatestMap<Entry>) =>
  Object.fromEntries([...map].map(([id, e]) => [id, e.text]));

describe("conversation latest merge", () => {
  it("takes a newer or the same message from an event and drops an older one", () => {
    let map = applyLatestEvent(new Map(), entry("a", 5));
    map = applyLatestEvent(map, entry("a", 4));
    expect(texts(map)).toEqual({ a: "a@5" });
    map = applyLatestEvent(map, entry("a", 5, "renamed sender"));
    expect(texts(map)).toEqual({ a: "renamed sender" });
  });

  it("refreshes entries from a snapshot", () => {
    const map = applyLatestSnapshot(new Map([["a", entry("a", 5)]]), [
      entry("a", 5, "fresh"),
      entry("b", 2),
    ]);
    expect(texts(map)).toEqual({ a: "fresh", b: "b@2" });
  });

  it("keeps an event that moved past a late snapshot", () => {
    const map = applyLatestSnapshot(new Map([["a", entry("a", 7)]]), [
      entry("a", 6),
      entry("b", 1),
    ]);
    expect(texts(map)).toEqual({ a: "a@7", b: "b@1" });
  });

  it("keeps an event that arrived before the first snapshot answered", () => {
    const beforeSnapshot = applyLatestEvent(new Map(), entry("a", 7));
    const map = applyLatestSnapshot(beforeSnapshot, [entry("a", 6), entry("b", 1)]);
    expect(texts(map)).toEqual({ a: "a@7", b: "b@1" });
  });

  it("keeps an event for a conversation the snapshot does not have yet", () => {
    const map = applyLatestSnapshot(applyLatestEvent(new Map(), entry("a", 7)), []);
    expect(texts(map)).toEqual({ a: "a@7" });
  });
});
