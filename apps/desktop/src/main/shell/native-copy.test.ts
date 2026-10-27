import { describe, expect, it } from "vitest";
import { nativeCopy, setNativeLocale } from "./native-copy.js";

describe("native copy locale", () => {
  it("switches only for a supported, different language", () => {
    expect(setNativeLocale("fr")).toBe(false);
    expect(setNativeLocale("en")).toBe(false);
    const english = nativeCopy().settings;
    expect(setNativeLocale("zh")).toBe(true);
    expect(nativeCopy().settings).not.toBe(english);
    expect(setNativeLocale("zh")).toBe(false);
    expect(setNativeLocale("en")).toBe(true);
    expect(nativeCopy().settings).toBe(english);
  });
});
