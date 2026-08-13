import { describe, expect, it } from 'vitest';
import {
  classifyReferenceHref,
  isPluginLink,
  isReferenceScheme,
  PLUGIN_LINK_PROP,
} from './reference-href';

/**
 * #task:2001 — the renderer's arm decision for the reference scheme.
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

describe('isReferenceScheme', () => {
  it('admits the canonical spelling', () => {
    expect(isReferenceScheme('silverhand://agent/Alice')).toBe(true);
  });

  it('admits any scheme case, because URI schemes are case-insensitive', () => {
    // The admission test must be at least as wide as what a browser would treat
    // as our scheme; otherwise `SILVERHAND://…` falls through to the opener.
    expect(isReferenceScheme('SILVERHAND://agent/Alice')).toBe(true);
    expect(isReferenceScheme('Silverhand://human/shiki')).toBe(true);
  });

  it('admits the bare scheme with nothing after it', () => {
    // Nothing parseable, but still ours — the arms must claim it.
    expect(isReferenceScheme('silverhand://')).toBe(true);
  });

  it('rejects other schemes and a mere substring match', () => {
    expect(isReferenceScheme('https://example.com')).toBe(false);
    expect(isReferenceScheme('silverhand-task:42')).toBe(false);
    // Not a prefix: the scheme test is anchored, so an interior occurrence is
    // someone else's URL and belongs to the opener.
    expect(isReferenceScheme('https://x.test/silverhand://agent/Alice')).toBe(
      false,
    );
  });
});

describe('isPluginLink', () => {
  it('is true only for the flag the remark pass writes', () => {
    expect(isPluginLink(stamped)).toBe(true);
    expect(isPluginLink(authored)).toBe(false);
    expect(isPluginLink(undefined)).toBe(false);
    expect(isPluginLink({})).toBe(false);
  });

  it('does not accept a truthy look-alike value', () => {
    // One writer, one reader, no coercion: a body cannot reach mdast metadata,
    // but a future plugin passing a string here would be a different contract
    // and should fail loudly rather than be coerced into provenance.
    expect(isPluginLink({ properties: { [PLUGIN_LINK_PROP]: 'true' } })).toBe(
      false,
    );
    expect(isPluginLink({ properties: { [PLUGIN_LINK_PROP]: 1 } })).toBe(false);
  });
});

describe('classifyReferenceHref — arm per destination', () => {
  it('draws a chip for a stamped, well-formed reference of each kind', () => {
    expect(classifyReferenceHref('silverhand://agent/Alice', stamped)).toEqual({
      arm: 'reference',
      reference: { kind: 'agent', handle: 'Alice' },
    });
    expect(classifyReferenceHref('silverhand://human/shiki', stamped)).toEqual({
      arm: 'reference',
      reference: { kind: 'human', handle: 'shiki' },
    });
  });

  it('keeps the handle exactly as written', () => {
    // Handles are case-sensitive everywhere; only the scheme is not.
    expect(classifyReferenceHref('silverhand://agent/alice', stamped)).toEqual({
      arm: 'reference',
      reference: { kind: 'agent', handle: 'alice' },
    });
  });

  it('is inert for a well-formed destination that was NOT stamped', () => {
    // Ruling C: the only spellings that reach a chip are the ones the remark pass
    // admitted. This is the case that used to be a chip, and it is the whole
    // behavioural change — a labelled link renders its label and addresses
    // nobody, so it must not look addressed.
    expect(classifyReferenceHref('silverhand://agent/Alice', authored)).toEqual({
      arm: 'inert',
    });
    expect(classifyReferenceHref('silverhand://human/shiki')).toEqual({
      arm: 'inert',
    });
  });

  it('is inert for an upper-case scheme, stamped or not', () => {
    // Admitted by the scheme test, refused by the strict parser — deliberately.
    // The strict parser is case-sensitive, so a chip here would promise a mention
    // the backend never recorded. Provenance does not soften that: syntax and
    // well-formedness are separate gates and both must pass.
    expect(classifyReferenceHref('SILVERHAND://agent/Alice', authored)).toEqual({
      arm: 'inert',
    });
    expect(classifyReferenceHref('SILVERHAND://agent/Alice', stamped)).toEqual({
      arm: 'inert',
    });
  });

  it('is inert for an unknown kind, a missing handle, or extra path', () => {
    for (const href of [
      'silverhand://',
      'silverhand://agent',
      'silverhand://agent/',
      'silverhand://team/Alice',
      'silverhand://agent/Alice/extra',
      'silverhand://agent/Alice?x=1',
      'silverhand://agent/Alice#frag',
      'silverhand://agent/Alice ',
      'silverhand://agent/9nine',
      'silverhand://app',
    ]) {
      // Both land on the same arm: unstamped because display refuses the
      // spelling, stamped because the destination itself does not parse.
      expect(classifyReferenceHref(href, authored), href).toEqual({
        arm: 'inert',
      });
      expect(classifyReferenceHref(href, stamped), href).toEqual({
        arm: 'inert',
      });
    }
  });

  it('is inert for a handle longer than a participant name can be', () => {
    expect(
      classifyReferenceHref(`silverhand://agent/${'a'.repeat(65)}`, stamped),
    ).toEqual({ arm: 'inert' });
  });

  it('leaves every other destination to the caller', () => {
    for (const href of [
      'https://example.com',
      'mailto:a@example.com',
      'silverhand-task:42',
      '',
      'javascript:alert(1)',
      // A destination that merely LOOKS like the old internal marker: the
      // provenance signal is no longer a string, so this is just an unknown
      // scheme and the caller's own arms refuse it.
      'silverhand-ref:silverhand://agent/Alice',
    ]) {
      expect(classifyReferenceHref(href, authored), href).toEqual({
        arm: 'other',
      });
      // Not even a stamped node can turn a foreign destination into a chip:
      // the scheme test runs first, so provenance can never route somebody
      // else's URL into the reference arm.
      expect(classifyReferenceHref(href, stamped), href).toEqual({
        arm: 'other',
      });
    }
  });

  it('leaves a missing href to the caller', () => {
    // `href` is optional on an mdast link node's rendered props.
    expect(classifyReferenceHref(undefined, stamped)).toEqual({ arm: 'other' });
    expect(classifyReferenceHref(null, stamped)).toEqual({ arm: 'other' });
  });
});
