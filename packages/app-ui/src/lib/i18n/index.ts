import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { en } from "./messages/en";
import { zh } from "./messages/zh";
import { locale, localeTag, subscribeLocale } from "./locale";
import type { ReactNode } from "react";
import { interpolateNodes } from "./rich";
import {
  format,
  type Catalog,
  type MessageKey,
  type ParamArgs,
  type ParamNames,
} from "./translate";

export {
  LOCALE_PREFERENCES,
  locale,
  localeTag,
  setLocalePreference,
  subscribeLocale,
  useLocale,
  useLocalePreference,
  type Locale,
  type LocalePreference,
} from "./locale";

type Messages = typeof en;
export type TranslationKey = MessageKey<Messages>;

let catalog: Catalog = en;
let rules = new Intl.PluralRules("en-US");

function applyLocale(): void {
  dayjs.locale(locale === "zh" ? "zh-cn" : "en");
  catalog = locale === "zh" ? zh : en;
  rules = new Intl.PluralRules(localeTag);
}

applyLocale();
subscribeLocale(applyLocale);

/** The active language's copy for `key`; English fills any gap. */
export function t<K extends TranslationKey>(key: K, ...args: ParamArgs<Messages, K>): string {
  return format(catalog, en, rules, key, args[0] as Record<string, string | number> | undefined);
}

/**
 * `t` for sentences that embed styled elements (names, chips, links): each
 * placeholder takes a React node, so translations can reorder them freely.
 */
export function tRich<K extends TranslationKey>(
  key: K,
  nodes: { [N in ParamNames<Messages, K>]: N extends "count" ? number : ReactNode },
): ReactNode {
  const count = (nodes as { count?: unknown }).count;
  const text = format(catalog, en, rules, key, typeof count === "number" ? { count } : {});
  return interpolateNodes(text, nodes as Record<string, ReactNode>);
}

export { withStrong } from "./rich";
