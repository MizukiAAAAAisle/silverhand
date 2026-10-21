import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_USER_DISPLAY_NAME,
  unknownUserDisplayName,
  clearCurrentUser,
  formatUserDisplayName,
  getCurrentUserId,
  isCurrentUserId,
  setCurrentUserId,
} from "./current-user";

describe("current-user", () => {
  afterEach(() => {
    clearCurrentUser();
  });

  describe("isCurrentUserId", () => {
    it("returns false for null/undefined even when no viewer is set", () => {
      expect(isCurrentUserId(null)).toBe(false);
      expect(isCurrentUserId(undefined)).toBe(false);
    });

    it("returns false for null/undefined even after viewer is set", () => {
      // Multi-human invariant (audit 2026-06-03 #task:857 P0.5 / P0 #2):
      // legacy null-authored rows must NOT collapse to "you", or every
      // viewer would see them as their own writes.
      setCurrentUserId("user-aaa", "Alice");
      expect(isCurrentUserId(null)).toBe(false);
      expect(isCurrentUserId(undefined)).toBe(false);
    });

    it("returns true only for the configured viewer id", () => {
      setCurrentUserId("user-aaa");
      expect(isCurrentUserId("user-aaa")).toBe(true);
      expect(isCurrentUserId("user-bbb")).toBe(false);
    });

    it("returns false until setCurrentUserId is called", () => {
      expect(isCurrentUserId("user-aaa")).toBe(false);
    });
  });

  describe("formatUserDisplayName", () => {
    it("returns the Unknown sentinel for null/undefined", () => {
      expect(formatUserDisplayName(null)).toBe(unknownUserDisplayName());
      expect(formatUserDisplayName(undefined)).toBe(unknownUserDisplayName());
    });

    it("returns the viewer display name for the viewer id", () => {
      setCurrentUserId("user-aaa", "Alice");
      expect(formatUserDisplayName("user-aaa")).toBe("Alice");
    });

    it('falls back to the "you" sentinel when no display name was supplied', () => {
      setCurrentUserId("user-aaa");
      expect(formatUserDisplayName("user-aaa")).toBe(CURRENT_USER_DISPLAY_NAME);
    });

    it("honors the resolver for non-viewer ids", () => {
      setCurrentUserId("user-aaa", "Alice");
      const resolver = (id: string) => (id === "user-bbb" ? "Bob" : null);
      expect(formatUserDisplayName("user-bbb", resolver)).toBe("Bob");
    });

    it("falls back to the raw id when the resolver returns null", () => {
      const resolver = () => null;
      expect(formatUserDisplayName("user-xyz", resolver)).toBe("user-xyz");
    });

    it("prefers the viewer name over the resolver", () => {
      setCurrentUserId("user-aaa", "Alice");
      const resolver = (_id: string) => "WRONG";
      expect(formatUserDisplayName("user-aaa", resolver)).toBe("Alice");
    });
  });

  describe("getCurrentUserId", () => {
    it("returns null before hydration", () => {
      expect(getCurrentUserId()).toBeNull();
    });

    it("returns the configured id after setCurrentUserId", () => {
      setCurrentUserId("user-aaa");
      expect(getCurrentUserId()).toBe("user-aaa");
    });

    it("returns null again after clearCurrentUser", () => {
      setCurrentUserId("user-aaa");
      clearCurrentUser();
      expect(getCurrentUserId()).toBeNull();
    });
  });
});
