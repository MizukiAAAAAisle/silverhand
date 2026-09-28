import { describe, expect, it } from "vitest";
import { BoundFrameReader } from "../embedded/rust-backend-frame.js";

const GEN = "gen-abc-123";
const phase = (kind: string, generation = GEN, overrides = {}) =>
  `${JSON.stringify({ v: 2, kind, generation, ...overrides })}\n`;
const frame = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 2,
    kind: "bound",
    generation: GEN,
    url: "http://127.0.0.1:51763",
    port: 51763,
    ...overrides,
  });
function preparedReader(generation = GEN): BoundFrameReader {
  const reader = new BoundFrameReader(generation);
  expect(reader.push(phase("preparing", generation) + phase("prepared", generation))).toEqual({
    status: "prepared",
  });
  return reader;
}

describe("startup stdout protocol", () => {
  it.each([
    ["http://127.0.0.1:51763", 51763],
    ["http://[::1]:40001", 40001],
  ] as const)("accepts literal v2 frames for %s", (url, port) => {
    expect(preparedReader().push(`${frame({ url, port })}\n`)).toEqual({
      status: "bound",
      frame: { url, port },
    });
  });

  it.each([
    [{ v: 1 }, "unknown-version"],
    [{ kind: "ready" }, "wrong-kind"],
    [{ generation: "other" }, "generation-mismatch"],
    [{ generation: 123 }, "generation-mismatch"],
    [{ secret: "leak" }, "extra-keys"],
    ...[0, 70000, 1.5].map((port) => [{ port }, "bad-port"] as const),
    ...[
      "http://127.0.0.1:9999",
      "http://10.0.0.5:51763",
      "https://127.0.0.1:51763",
      "http://127.0.0.1:51763/x",
      "http://127.0.0.1:51763/?q=x",
      "http://127.0.0.1:51763/#x",
      "http://user:secret@127.0.0.1:51763",
    ].map((url) => [{ url }, "bad-url"] as const),
  ] as const)("rejects malformed bound frame %j", (overrides, reason) => {
    expect(preparedReader().push(`${frame(overrides)}\n`)).toEqual({ status: "invalid", reason });
  });

  it.each([
    ["not json", "not-json"],
    ["[1,2,3]", "not-object"],
    ["null", "not-object"],
  ])("rejects non-frame %s", (raw, reason) => {
    expect(preparedReader().push(`${raw}\n`)).toEqual({ status: "invalid", reason });
  });

  it.each([
    [frame() + "\n", "wrong-kind"],
    [phase("prepared"), "wrong-kind"],
    [phase("preparing") + phase("preparing"), "wrong-kind"],
    [phase("preparing") + phase("prepared", "wrong"), "generation-mismatch"],
    [phase("preparing", GEN, { v: 1 }), "unknown-version"],
    [phase("preparing") + phase("prepared", GEN, { secret: "leak" }), "extra-keys"],
  ])("rejects invalid phase sequence %s", (lines, reason) => {
    expect(new BoundFrameReader(GEN).push(lines)).toEqual({ status: "invalid", reason });
  });

  it("processes coalesced phases in order, ignoring blank lines", () => {
    const phases: string[] = [];
    const reader = new BoundFrameReader(GEN, (phase) => phases.push(phase));
    expect(reader.push("\n")).toBeNull();
    expect(reader.push(phase("preparing") + phase("prepared") + frame() + "\n")).toEqual({
      status: "bound",
      frame: { url: "http://127.0.0.1:51763", port: 51763 },
    });
    expect(phases).toEqual(["preparing", "prepared"]);
    expect(reader.push(" \n")).toMatchObject({ status: "bound" });
    expect(reader.push("anything\n")).toEqual({ status: "duplicate" });
  });

  it("never recovers from invalid input by reading a later valid line", () => {
    const reader = new BoundFrameReader(GEN);
    expect(reader.push("garbage\n")).toEqual({ status: "invalid", reason: "not-json" });
    expect(reader.push(frame() + "\n")).toEqual({ status: "duplicate" });
  });

  it("reassembles split UTF8 before decoding and bounds unfinished post-bound data", () => {
    const generation = "世界-🌍";
    const bytes = Buffer.from(frame({ generation }) + "\n");
    const split = bytes.indexOf(Buffer.from(generation)) + 1;
    const reader = preparedReader(generation);
    expect(reader.push(bytes.subarray(0, split))).toEqual({ status: "prepared" });
    expect(reader.push(bytes.subarray(split, -1))).toEqual({ status: "prepared" });
    expect(reader.push("\n")).toEqual({
      status: "bound",
      frame: { url: "http://127.0.0.1:51763", port: 51763 },
    });
    expect(reader.push(Buffer.alloc(4096, 97))).toEqual({ status: "invalid", reason: "oversize" });
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("enforces the 4096-byte cap on valid JSON (split=%s newline=%s)", (split, newline) => {
    const generation = "世".repeat(1000);
    const json = frame({ generation });
    const line = json + " ".repeat(4095 - Buffer.byteLength(json));
    const accepted = preparedReader(generation);
    expect(accepted.push(line + "\n")).toMatchObject({ status: "bound" });
    const rejected = preparedReader(generation);
    const bytes = Buffer.from(line + " " + (newline ? "\n" : ""));
    if (split) expect(rejected.push(bytes.subarray(0, 2048))).toEqual({ status: "prepared" });
    expect(rejected.push(split ? bytes.subarray(2048) : bytes)).toEqual({
      status: "invalid",
      reason: "oversize",
    });
  });
});
