/** A count-dependent string. Chinese needs only `other`. */
export interface Plural {
  one?: string;
  other: string;
}

export interface Catalog {
  readonly [key: string]: string | Plural | Catalog;
}

/** Dotted paths to every string or plural in a catalog. */
export type MessageKey<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string | Plural
    ? `${Prefix}${K}`
    : MessageKey<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

type At<T, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? At<T[Head], Rest>
    : never
  : Path extends keyof T
    ? T[Path]
    : never;

type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;

type ValuesOf<V> = V extends Plural ? V["other"] | NonNullable<V["one"]> : V;

type ParamsOf<V> = V extends Plural
  ? { count: number } & { [N in Exclude<Placeholders<ValuesOf<V>>, "count">]: string | number }
  : { [N in Placeholders<V>]: string | number };

/** Placeholder names (including `count` for plurals) used by the string at `K`. */
export type ParamNames<T, K extends string> =
  | Placeholders<ValuesOf<At<T, K>>>
  | (At<T, K> extends Plural ? "count" : never);

/** `t(key)` for plain strings, `t(key, params)` when the string has placeholders or a count. */
export type ParamArgs<T, K extends string> = [Placeholders<ValuesOf<At<T, K>>>] extends [never]
  ? At<T, K> extends Plural
    ? [params: ParamsOf<At<T, K>>]
    : []
  : [params: ParamsOf<At<T, K>>];

/** The same keys as the source catalog, with any wording. */
export type Translation<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends Plural ? Plural : Translation<T[K]>;
};

function lookup(catalog: Catalog, key: string): string | Plural | undefined {
  let node: string | Plural | Catalog | undefined = catalog;
  for (const part of key.split(".")) {
    if (node === undefined || typeof node === "string") {
      return undefined;
    }
    node = (node as Catalog)[part];
  }
  return node as string | Plural | undefined;
}

function isPlural(value: string | Plural): value is Plural {
  return typeof value === "object";
}

export function format(
  catalog: Catalog,
  fallback: Catalog,
  rules: Intl.PluralRules,
  key: string,
  params: Record<string, string | number> = {},
): string {
  const value = lookup(catalog, key) ?? lookup(fallback, key) ?? key;
  let text: string;
  if (isPlural(value)) {
    const count = Number(params["count"] ?? 0);
    text = rules.select(count) === "one" && value.one !== undefined ? value.one : value.other;
  } else {
    text = value;
  }

  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
