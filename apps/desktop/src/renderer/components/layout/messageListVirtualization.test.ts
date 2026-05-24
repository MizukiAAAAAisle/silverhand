import { describe, expect, it } from 'vitest';
import {
  getFollowOutputBehavior,
  getInitialTopMostItemIndex,
  shouldRemountForJump,
  shouldRemountForWindowReplacement,
} from './messageListVirtualization';

describe('message list virtualization helpers', () => {
  describe('getInitialTopMostItemIndex', () => {
    it('centers the jump target when it is present', () => {
      expect(
        getInitialTopMostItemIndex({
          jumpTargetIndex: 42,
          hasJumpTarget: true,
          itemCount: 100,
        }),
      ).toEqual({ index: 42, align: 'center' });
    });

    it('omits initial index while a jump target is pending but absent', () => {
      expect(
        getInitialTopMostItemIndex({
          jumpTargetIndex: -1,
          hasJumpTarget: true,
          itemCount: 100,
        }),
      ).toBeUndefined();
    });

    it('opens ordinary channel mounts at the local bottom', () => {
      expect(
        getInitialTopMostItemIndex({
          jumpTargetIndex: -1,
          hasJumpTarget: false,
          itemCount: 100,
        }),
      ).toBe(99);
    });

    it('keeps the ordinary empty-list fallback non-negative', () => {
      expect(
        getInitialTopMostItemIndex({
          jumpTargetIndex: -1,
          hasJumpTarget: false,
          itemCount: 0,
        }),
      ).toBe(0);
    });
  });

  describe('shouldRemountForWindowReplacement', () => {
    it('remounts ordinary latest/window replacements', () => {
      expect(
        shouldRemountForWindowReplacement({
          hasJumpTarget: false,
          jumpTargetIndex: -1,
        }),
      ).toBe(true);
    });

    it('remounts jump windows only after the target is present', () => {
      expect(
        shouldRemountForWindowReplacement({
          hasJumpTarget: true,
          jumpTargetIndex: 12,
        }),
      ).toBe(true);
      expect(
        shouldRemountForWindowReplacement({
          hasJumpTarget: true,
          jumpTargetIndex: -1,
        }),
      ).toBe(false);
    });
  });

  describe('shouldRemountForJump', () => {
    it('remounts only when an active jump target is present in the window', () => {
      expect(
        shouldRemountForJump({
          hasJumpTarget: true,
          jumpTargetIndex: 9,
        }),
      ).toBe(true);
      expect(
        shouldRemountForJump({
          hasJumpTarget: true,
          jumpTargetIndex: -1,
        }),
      ).toBe(false);
      expect(
        shouldRemountForJump({
          hasJumpTarget: false,
          jumpTargetIndex: 9,
        }),
      ).toBe(false);
    });
  });

  describe('getFollowOutputBehavior', () => {
    it('follows only when the user is at the real conversation tail', () => {
      expect(
        getFollowOutputBehavior({
          hasJumpTarget: false,
          isAtTail: true,
          atBottom: true,
        }),
      ).toBe('auto');
    });

    it('does not follow during jumps, non-tail windows, or manual history reads', () => {
      expect(
        getFollowOutputBehavior({
          hasJumpTarget: true,
          isAtTail: true,
          atBottom: true,
        }),
      ).toBe(false);
      expect(
        getFollowOutputBehavior({
          hasJumpTarget: false,
          isAtTail: false,
          atBottom: true,
        }),
      ).toBe(false);
      expect(
        getFollowOutputBehavior({
          hasJumpTarget: false,
          isAtTail: true,
          atBottom: false,
        }),
      ).toBe(false);
    });
  });
});
