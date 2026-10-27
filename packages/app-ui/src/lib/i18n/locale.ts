import { useSyncExternalStore } from "react";

export type Locale = "en" | "zh";
export type LocalePreference = "system" | Locale;

export const LOCALE_PREFERENCES: ReadonlyArray<LocalePreference> = ["system", "en", "zh"];

const STORAGE_KEY = "silverhand:locale";

/** The first system language Silverhand speaks decides; anything else reads English. */
export function systemLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const tag = language.toLowerCase();
    if (tag === "zh" || tag.startsWith("zh-")) {
      return "zh";
    }
    if (tag === "en" || tag.startsWith("en-")) {
      return "en";
    }
  }
  return "en";
}

export function resolveLocale(preference: LocalePreference, languages: readonly string[]): Locale {
  return preference === "system" ? systemLocale(languages) : preference;
}

function parsePreference(raw: string | null): LocalePreference {
  return raw === "en" || raw === "zh" ? raw : "system";
}

function readPreference(): LocalePreference {
  try {
    return parsePreference(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "system";
  }
}

function systemLanguages(): readonly string[] {
  // Outside a browser (tests, scripts) the host's language must not leak into copy.
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return [];
  }
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

let preference: LocalePreference = readPreference();

/** The language copy reads in right now. Changing it re-renders the app in place. */
export let locale: Locale = resolveLocale(preference, systemLanguages());

/** BCP 47 tag for `Intl` and `<html lang>`. */
export let localeTag = tagOf(locale);

function tagOf(next: Locale): string {
  return next === "zh" ? "zh-CN" : "en-US";
}

const listeners = new Set<() => void>();

export function setLocalePreference(next: LocalePreference): void {
  if (next === preference) {
    return;
  }

  preference = next;
  try {
    if (next === "system") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, next);
    }
  } catch {
    // Storage refused: the choice lasts for this page only.
  }
  locale = resolveLocale(next, systemLanguages());
  localeTag = tagOf(locale);
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getPreference(): LocalePreference {
  return preference;
}

export function useLocalePreference(): LocalePreference {
  return useSyncExternalStore(subscribeLocale, getPreference, getPreference);
}

function getLocale(): Locale {
  return locale;
}

/** The active language; subscribing components re-render when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
