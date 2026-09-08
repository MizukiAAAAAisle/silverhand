import { describe, expect, it } from "vitest";
import {
  AUTHORED_HREF_PROP,
  authoredHref,
  classifyReferenceHref,
  isPluginLink,
  isReferenceScheme,
  PLUGIN_LINK_PROP,
} from "./reference-href";

/**
 * The renderer's arm decision for the reference scheme.
 *
 * These are BEHAVIOUR assertions, not painting: `other` is the arm whose tail
 * hands the href to `window.silverhand.openExternal`, so every case below that
 * expects `inert` is asserting that an internal destination cannot be shelled
 * out to the OS. The pair (`isReferenceScheme` wide, `parseReference` strict) is
 * what makes that hold — widening the parser or narrowing the scheme test
 * independently is exactly how the two come apart.
 *
 * Provenance is the third participant (shiki's ruling C, 2026-08-13): only a
 * destination `remarkRefs` stamped as a bare autolink can become a chip, so an
 * UNSTAMPED destination in our scheme is inert no matter how well-formed it is.
 * The flag is asserted here as tree metadata rather than as a string in the href
 * because a message body is attacker input (@Cindy) — the end-to-end half, which
 * SPELLINGS get stamped and that the flag never reaches the DOM, is asserted in
 * `Markdown.test.ts`, where a real body is parsed.
 */

/** A link node as `remarkRefs` leaves it. */
const stamped = { properties: { [PLUGIN_LINK_PROP]: true } };
/** A link node exactly as an author's body produces it: no metadata at all. */
const authored = { properties: {} };

/** A link node as `remarkRefs` leaves it, carrying the authored destination too
 *  (#task:2120). `href` is what hast serialization would have produced from
 *  `url`; the two differ exactly when `normalizeUri` had bytes to rewrite. */
function stampedWith(url: string): { properties: Record<string, unknown> } {
  return {
    properties: { [PLUGIN_LINK_PROP]: true, [AUTHORED_HREF_PROP]: url },
  };
}

describe("isReferenceScheme", () => {
  it("admits the canonical spelling", () => {
    expect(isReferenceScheme("silverhand://agent/Alice")).toBe(true);
  });

  it("admits any scheme case, because URI schemes are case-insensitive", () => {
    // The admission test must be at least as wide as what a browser would treat
    // as our scheme; otherwise `SILVERHAND://…` falls through to the opener.
    expect(isReferenceScheme("SILVERHAND://agent/Alice")).toBe(true);
    expect(isReferenceScheme("Silverhand://human/shiki")).toBe(true);
  });

  it("admits the bare scheme with nothing after it", () => {
    // Nothing parseable, but still ours — the arms must claim it.
    expect(isReferenceScheme("silverhand://")).toBe(true);
  });

  it("rejects other schemes and a mere substring match", () => {
    expect(isReferenceScheme("https://example.com")).toBe(false);
    expect(isReferenceScheme("silverhand-task:42")).toBe(false);
    // Not a prefix: the scheme test is anchored, so an interior occurrence is
    // someone else's URL and belongs to the opener.
    expect(isReferenceScheme("https://x.test/silverhand://agent/Alice")).toBe(false);
  });
});

describe("isPluginLink", () => {
  it("is true only for the flag the remark pass writes", () => {
    expect(isPluginLink(stamped)).toBe(true);
    expect(isPluginLink(authored)).toBe(false);
    expect(isPluginLink(undefined)).toBe(false);
    expect(isPluginLink({})).toBe(false);
  });

  it("does not accept a truthy look-alike value", () => {
    // One writer, one reader, no coercion: a body cannot reach mdast metadata,
    // but a future plugin passing a string here would be a different contract
    // and should fail loudly rather than be coerced into provenance.
    expect(isPluginLink({ properties: { [PLUGIN_LINK_PROP]: "true" } })).toBe(false);
    expect(isPluginLink({ properties: { [PLUGIN_LINK_PROP]: 1 } })).toBe(false);
  });
});

describe("classifyReferenceHref — arm per destination", () => {
  it("draws a chip for a stamped, well-formed reference of each kind", () => {
    expect(classifyReferenceHref("silverhand://agent/Alice", stamped)).toEqual({
      arm: "reference",
      reference: { kind: "agent", handle: "Alice" },
    });
    expect(classifyReferenceHref("silverhand://human/shiki", stamped)).toEqual({
      arm: "reference",
      reference: { kind: "human", handle: "shiki" },
    });
  });

  it("keeps the handle exactly as written", () => {
    // Handles are case-sensitive everywhere; only the scheme is not.
    expect(classifyReferenceHref("silverhand://agent/alice", stamped)).toEqual({
      arm: "reference",
      reference: { kind: "agent", handle: "alice" },
    });
  });

  it("is inert for a well-formed destination that was NOT stamped", () => {
    // Ruling C: the only spellings that reach a chip are the ones the remark pass
    // admitted. This is the case that used to be a chip, and it is the whole
    // behavioural change — a labelled link renders its label and addresses
    // nobody, so it must not look addressed.
    expect(classifyReferenceHref("silverhand://agent/Alice", authored)).toEqual({
      arm: "inert",
    });
    expect(classifyReferenceHref("silverhand://human/shiki")).toEqual({
      arm: "inert",
    });
  });

  it("is inert for an upper-case scheme, stamped or not", () => {
    // Admitted by the scheme test, refused by the strict parser — deliberately.
    // The strict parser is case-sensitive, so a chip here would promise a mention
    // the backend never recorded. Provenance does not soften that: syntax and
    // well-formedness are separate gates and both must pass.
    expect(classifyReferenceHref("SILVERHAND://agent/Alice", authored)).toEqual({
      arm: "inert",
    });
    expect(classifyReferenceHref("SILVERHAND://agent/Alice", stamped)).toEqual({
      arm: "inert",
    });
  });

  it("is inert for an unknown kind, a missing handle, or extra path", () => {
    for (const href of [
      "silverhand://",
      "silverhand://agent",
      "silverhand://agent/",
      "silverhand://team/Alice",
      "silverhand://agent/Alice/extra",
      "silverhand://agent/Alice?x=1",
      "silverhand://agent/Alice#frag",
      "silverhand://agent/Alice ",
      "silverhand://agent/9nine",
      "silverhand://app",
    ]) {
      // Both land on the same arm: unstamped because display refuses the
      // spelling, stamped because the destination itself does not parse.
      expect(classifyReferenceHref(href, authored), href).toEqual({
        arm: "inert",
      });
      expect(classifyReferenceHref(href, stamped), href).toEqual({
        arm: "inert",
      });
    }
  });

  it("is inert for a handle longer than a participant name can be", () => {
    expect(classifyReferenceHref(`silverhand://agent/${"a".repeat(65)}`, stamped)).toEqual({
      arm: "inert",
    });
  });

  it("leaves every other destination to the caller", () => {
    for (const href of [
      "https://example.com",
      "mailto:a@example.com",
      "silverhand-task:42",
      "",
      "javascript:alert(1)",
      // A destination that merely LOOKS like the old internal marker: the
      // provenance signal is no longer a string, so this is just an unknown
      // scheme and the caller's own arms refuse it.
      "silverhand-ref:silverhand://agent/Alice",
    ]) {
      expect(classifyReferenceHref(href, authored), href).toEqual({
        arm: "other",
      });
      // Not even a stamped node can turn a foreign destination into a chip:
      // the scheme test runs first, so provenance can never route somebody
      // else's URL into the reference arm.
      expect(classifyReferenceHref(href, stamped), href).toEqual({
        arm: "other",
      });
    }
  });

  it("leaves a missing href to the caller", () => {
    // `href` is optional on an mdast link node's rendered props.
    expect(classifyReferenceHref(undefined, stamped)).toEqual({ arm: "other" });
    expect(classifyReferenceHref(null, stamped)).toEqual({ arm: "other" });
  });
});

/**
 * #task:2120 — the locator arm, whose whole subject is WHICH BYTES DECIDE.
 *
 * Between mdast and this function, `href` has been through
 * `normalizeUri` — so for every locator whose names contain a byte outside
 * `[!#$&-;=?-Z_a-z~]`, the href is a DIFFERENT STRING from what the author wrote,
 * and the strict grammar correctly refuses that second spelling. The pair of cases
 * below is the proof that the decision does not read it: the SAME href
 * (`…/a%5Eb`) yields a chip when the author wrote `a^b` and no chip when the author
 * wrote `a%5Eb`, because over-escaping is not the canonical spelling of that name.
 */
describe("classifyReferenceHref — locator arm reads the authored bytes", () => {
  it("draws a chip from bytes the href no longer carries", () => {
    // Exactly the form `locator.ts` documents: `%2F` / `%20` are already the
    // canonical spelling of a slash and a space, the CJK is raw.
    const url = "silverhand://workspace/silverhand/UI%2FUX%20优化";
    // What `normalizeUri` hands the component: the CJK is gone.
    const href = "silverhand://workspace/silverhand/UI%2FUX%20%E4%BC%98%E5%8C%96";

    expect(classifyReferenceHref(href, stampedWith(url))).toMatchObject({
      arm: "locator",
      locator: { kind: "channel" },
    });
    // The same node without the authored bytes: the href alone cannot produce it.
    expect(classifyReferenceHref(href, stamped)).toEqual({ arm: "inert" });
  });

  it("decides on the authored spelling even when both spell one name", () => {
    // Identical `href`, opposite outcomes — the whole point.
    const href = "silverhand://workspace/a%5Eb";
    expect(classifyReferenceHref(href, stampedWith("silverhand://workspace/a^b"))).toMatchObject({
      arm: "locator",
    });
    expect(classifyReferenceHref(href, stampedWith("silverhand://workspace/a%5Eb"))).toEqual({
      arm: "inert",
    });
  });

  it("accepts an already-escaped name, which is that name canonically", () => {
    // `%2F` and `%20` are the canonical spelling of a slash and a space in a
    // segment, so these are not "encoded" locators — they are the locator.
    expect(
      classifyReferenceHref(
        "silverhand://workspace/silverhand/UI%2FUX%20design",
        stampedWith("silverhand://workspace/silverhand/UI%2FUX%20design"),
      ),
    ).toMatchObject({ arm: "locator", locator: { kind: "channel" } });
  });

  it("is inert without the authored bytes, never falling back to the href", () => {
    // Review point 1 (@Cindy): one authority. An ASCII-only locator would parse
    // from the href just fine, which is exactly why a fallback would be invisible
    // until the first name with a CJK character in it.
    const href = "silverhand://dm/Cindy/shiki";
    expect(classifyReferenceHref(href, stamped)).toEqual({ arm: "inert" });
    expect(classifyReferenceHref(href, stampedWith(href))).toMatchObject({
      arm: "locator",
      locator: { kind: "direct_pair" },
    });
  });

  it("is inert for an unstamped node however well-formed the destination", () => {
    // Provenance still gates first: a labelled `[text](silverhand://workspace/x)`
    // is not a coordinate the author wrote as one.
    expect(
      classifyReferenceHref("silverhand://workspace/x", {
        properties: { [AUTHORED_HREF_PROP]: "silverhand://workspace/x" },
      }),
    ).toEqual({ arm: "inert" });
  });

  it("is inert for a destination neither grammar accepts", () => {
    for (const url of [
      "silverhand://workspace",
      "silverhand://workspace/",
      "silverhand://workspace/a/b/c/d",
      "silverhand://dm/Cindy",
      // A self-pair is not a coordinate (`locator.ts`).
      "silverhand://dm/shiki/shiki",
      // Case is canonical for a root word too.
      "silverhand://Workspace/x",
    ]) {
      expect(classifyReferenceHref(url, stampedWith(url)), url).toEqual({
        arm: "inert",
      });
    }
  });

  it("lets the addressing grammar win, and cannot be crossed", () => {
    // The two grammars are disjoint by root word, so a reference destination
    // carrying authored bytes is still a reference — and a locator's root word can
    // never produce one.
    expect(
      classifyReferenceHref("silverhand://agent/Alice", stampedWith("silverhand://agent/Alice")),
    ).toEqual({ arm: "reference", reference: { kind: "agent", handle: "Alice" } });
  });
});

describe("authoredHref", () => {
  it("reads only a string written by the remark pass", () => {
    expect(authoredHref(stampedWith("silverhand://workspace/x"))).toBe("silverhand://workspace/x");
    expect(authoredHref(stamped)).toBe(null);
    expect(authoredHref(undefined)).toBe(null);
    // One writer, one reader: anything but a string means the assumption behind
    // this prop no longer holds, and guessing at it would be a second authority.
    expect(authoredHref({ properties: { [AUTHORED_HREF_PROP]: true } })).toBe(null);
  });
});
