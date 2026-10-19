// Types of the message catalogue (ADR 0072 decision 1): the key union and the argument type of every message are derived from the
// English catalogue, so a wrong key or a missing argument is a compile error. Only types and two constants live here.
import type { enMessages } from './messages/en.ts';

/** The languages of the UI; English is bundled, Vietnamese is a lazily loaded chunk. */
export const LOCALES = ['en', 'vi'] as const;
export type Locale = (typeof LOCALES)[number];

/** The stored choice (`locale` in the preferences): `auto` follows the browser languages. */
export type LocalePreference = 'auto' | Locale;

/** A loaded catalogue: message key to message text. */
export type Messages = Readonly<Record<string, string>>;

/** The English catalogue; its keys are the keys of every catalogue. */
export type EnglishMessages = typeof enMessages;
export type MessageKey = keyof EnglishMessages;

/** What a message accepts for an argument; numbers are formatted for the active language. */
export type MessageValue = string | number;

type Space = ' ' | '\n' | '\t';
type TrimStart<S extends string> = S extends `${Space}${infer R}` ? TrimStart<R> : S;
type TrimEnd<S extends string> = S extends `${infer R}${Space}` ? TrimEnd<R> : S;
type Trim<S extends string> = TrimStart<TrimEnd<S>>;

// The forms of a plural are `selector {text}` groups without nested braces; the plural ends at the first `}` that follows a form.
// Returns the text after the closing brace of the plural.
type SkipForms<S extends string> = S extends `${string}{${string}}${infer R}`
  ? TrimStart<R> extends `}${infer Tail}`
    ? Tail
    : SkipForms<R>
  : '';

// `After` is the text right after an opening brace. A comma before the first closing brace makes it a plural header.
type PlaceholdersAfter<After extends string, OnlyPlural extends boolean> = After extends `${infer Head},${infer Tail}`
  ? Head extends `${string}}${string}`
    ? SimpleAfter<After, OnlyPlural>
    : Trim<Head> | Placeholders<SkipForms<Tail>, OnlyPlural>
  : SimpleAfter<After, OnlyPlural>;

type SimpleAfter<After extends string, OnlyPlural extends boolean> = After extends `${infer Name}}${infer Rest}`
  ? (OnlyPlural extends true ? never : Trim<Name>) | Placeholders<Rest, OnlyPlural>
  : never;

type Placeholders<S extends string, OnlyPlural extends boolean> = S extends `${string}{${infer After}`
  ? PlaceholdersAfter<After, OnlyPlural>
  : never;

/** The names of the arguments of a message text: `{name}` and the counter of `{count, plural, ...}`. */
export type PlaceholderNames<S extends string> = Placeholders<S, false>;

/** The names that are plural counters (they must be numbers). */
export type PluralArgNames<S extends string> = Placeholders<S, true>;

type NamesOf<K extends MessageKey> = PlaceholderNames<EnglishMessages[K]>;
type PluralNamesOf<K extends MessageKey> = PluralArgNames<EnglishMessages[K]>;

/** The arguments object of a message; a message without placeholders has none. */
export type MessageArgs<K extends MessageKey> = [NamesOf<K>] extends [never]
  ? Record<string, never>
  : { readonly [N in NamesOf<K>]: N extends PluralNamesOf<K> ? number : MessageValue };

/** The rest parameters of `t(key, ...)`: the arguments are required exactly when the message has placeholders. */
export type ArgsTuple<K extends MessageKey> = [NamesOf<K>] extends [never]
  ? [args?: undefined]
  : [args: MessageArgs<K>];

/** `t` of `useT()`: the text of a message in the active language. */
export type TFunction = <K extends MessageKey>(key: K, ...args: ArgsTuple<K>) => string;
