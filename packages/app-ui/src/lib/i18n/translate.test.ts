import { describe, expect, it } from "vitest";
import { format, type Catalog } from "./translate";
import { resolveLocale, systemLocale } from "./locale";

const en: Catalog = {
  a: {
    plain: "Hello",
    named: "Hi {name}",
    count: { one: "{count} message", other: "{count} messages" },
  },
  onlyEn: "English only",
};
const zh: Catalog = {
  a: { plain: "你好", named: "{name}，你好", count: { other: "{count} 条消息" } },
};
const enRules = new Intl.PluralRules("en-US");
const zhRules = new Intl.PluralRules("zh-CN");

describe("format", () => {
  it("fills placeholders", () => {
    expect(format(zh, en, zhRules, "a.named", { name: "shiki" })).toBe("shiki，你好");
  });

  it("picks the plural form by count", () => {
    expect(format(en, en, enRules, "a.count", { count: 1 })).toBe("1 message");
    expect(format(en, en, enRules, "a.count", { count: 3 })).toBe("3 messages");
    expect(format(zh, en, zhRules, "a.count", { count: 1 })).toBe("1 条消息");
  });

  it("falls back to English, then to the key", () => {
    expect(format(zh, en, zhRules, "onlyEn")).toBe("English only");
    expect(format(zh, en, zhRules, "missing.key")).toBe("missing.key");
  });

  it("leaves unknown placeholders visible", () => {
    expect(format(en, en, enRules, "a.named", {})).toBe("Hi {name}");
  });
});

describe("locale", () => {
  it("takes the first system language Silverhand speaks", () => {
    expect(systemLocale(["zh-Hans-CN", "en-US"])).toBe("zh");
    expect(systemLocale(["fr-FR", "en-GB", "zh-CN"])).toBe("en");
    expect(systemLocale(["ja-JP", "zh-TW"])).toBe("zh");
    expect(systemLocale(["ja-JP"])).toBe("en");
    expect(systemLocale([])).toBe("en");
  });

  it("lets an explicit choice override the system", () => {
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale("system", ["zh-CN"])).toBe("zh");
  });
});
