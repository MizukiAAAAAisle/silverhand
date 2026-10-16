import { describe, expect, it } from "vitest";
import type { AvatarCategory, AvatarLibrary } from "./avatar-library";
import { AVATAR_LIBRARY } from "./avatar-library";
import {
  composeAvatarSvg,
  defaultAvatarConfig,
  normalizeAvatarConfig,
  randomAvatarConfig,
} from "./avatar-config";

const HAIR: AvatarCategory = {
  id: "hair",
  view: [0, 0, 200, 200],
  optional: true,
  default: 0,
  randomSkip: 0.5,
  parts: [
    { back: [{ t: "path", d: "M1 1" }], front: [{ t: "path", d: "M2 2" }] },
    { front: [{ t: "path", d: "M3 3" }] },
  ],
};

const LIBRARY: AvatarLibrary = {
  version: 1,
  size: 200,
  order: ["background", "hair.back", "face", "hair.front", "headwear"],
  face: [{ t: "circle", cx: 100, cy: 100, r: 40, fill: "#fff" }],
  backgrounds: ["#111111", "#222222"],
  categories: [
    HAIR,
    {
      id: "headwear",
      view: [0, 0, 200, 200],
      optional: true,
      default: -1,
      parts: [{ front: [{ t: "path", d: "M9 9" }], hides: ["hair"] }],
    },
  ],
};

describe("normalizeAvatarConfig", () => {
  it("keeps a valid config unchanged", () => {
    const config = { parts: { hair: 1, headwear: -1 }, bg: 1 };

    expect(normalizeAvatarConfig(config, LIBRARY)).toEqual(config);
  });

  it("falls back to defaults for removed parts, missing categories and a bad background", () => {
    expect(normalizeAvatarConfig({ parts: { hair: 7 }, bg: 9 }, LIBRARY)).toEqual({
      parts: { hair: 0, headwear: -1 },
      bg: 0,
    });
  });

  it("rejects -1 for a required category", () => {
    const required: AvatarLibrary = {
      ...LIBRARY,
      categories: [{ ...HAIR, optional: false }],
    };

    expect(normalizeAvatarConfig({ parts: { hair: -1 }, bg: 0 }, required).parts.hair).toBe(0);
  });

  it("returns the default config for non-object input", () => {
    expect(normalizeAvatarConfig("nope", LIBRARY)).toEqual(defaultAvatarConfig(LIBRARY));
  });
});

describe("composeAvatarSvg", () => {
  it("stacks layers in library order with hair split around the face", () => {
    const svg = composeAvatarSvg({ parts: { hair: 0, headwear: -1 }, bg: 1 }, LIBRARY);

    expect(svg.indexOf('fill="#222222"')).toBeLessThan(svg.indexOf('d="M1 1"'));
    expect(svg.indexOf('d="M1 1"')).toBeLessThan(svg.indexOf('r="40"'));
    expect(svg.indexOf('r="40"')).toBeLessThan(svg.indexOf('d="M2 2"'));
  });

  it("drops categories hidden by a selected part", () => {
    const svg = composeAvatarSvg({ parts: { hair: 0, headwear: 0 }, bg: 0 }, LIBRARY);

    expect(svg).toContain('d="M9 9"');
    expect(svg).not.toContain('d="M1 1"');
    expect(svg).not.toContain('d="M2 2"');
  });
});

describe("randomAvatarConfig", () => {
  it("always produces a config that survives normalization", () => {
    for (let seed = 0; seed < 50; seed += 1) {
      let state = seed;
      const random = () => {
        state = (state * 9301 + 49297) % 233280;

        return state / 233280;
      };
      const config = randomAvatarConfig(AVATAR_LIBRARY, random);

      expect(normalizeAvatarConfig(config, AVATAR_LIBRARY)).toEqual(config);
    }
  });
});
