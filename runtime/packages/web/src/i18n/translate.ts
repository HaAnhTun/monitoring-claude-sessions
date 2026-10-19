// The catalogues and the pure `translate` (ADR 0072 decision 2). English is bundled; Vietnamese is a separate chunk that is imported
// the first time it is needed. Until a catalogue is loaded, and when its load fails, the text is English. Nothing here is React.
import { formatMessage, isMessageArgs, MessageSyntaxError } from './format-message.ts';
import { enMessages } from './messages/en.ts';
import { LOCALES, type ArgsTuple, type Locale, type MessageKey, type Messages, type TFunction } from './types.ts';

/** Strict in tests and in the development server: a wrong key or argument fails at once. A production page degrades instead. */
const STRICT = !import.meta.env.PROD;

export interface Catalogues {
  /** The loaded catalogue of a locale, or undefined while it is not loaded. */
  readonly messages: (locale: Locale) => Messages | undefined;
  readonly isLoaded: (locale: Locale) => boolean;
  /** Loads a catalogue once; resolves true when it is available and false when the load failed (the next call tries again). */
  readonly load: (locale: Locale) => Promise<boolean>;
  /** Called after a catalogue was loaded. */
  readonly subscribe: (listener: () => void) => () => void;
}

export interface CataloguesOptions {
  initial?: Partial<Record<Locale, Messages>>;
  loaders?: Partial<Record<Locale, () => Promise<Messages>>>;
}

export function createCatalogues(options: CataloguesOptions): Catalogues {
  const loaded = new Map<Locale, Messages>();
  const pending = new Map<Locale, Promise<boolean>>();
  const listeners = new Set<() => void>();
  for (const locale of LOCALES) {
    const initial = options.initial?.[locale];
    if (initial !== undefined) loaded.set(locale, initial);
  }

  function start(locale: Locale): Promise<boolean> {
    const loader = options.loaders?.[locale];
    if (loader === undefined) return Promise.resolve(false);
    let request: Promise<Messages>;
    try {
      request = loader();
    } catch {
      return Promise.resolve(false);
    }
    return request.then(
      (messages) => {
        loaded.set(locale, messages);
        for (const listener of [...listeners]) listener();
        return true;
      },
      () => false,
    );
  }

  return {
    messages: (locale) => loaded.get(locale),
    isLoaded: (locale) => loaded.has(locale),
    load(locale) {
      if (loaded.has(locale)) return Promise.resolve(true);
      const running = pending.get(locale);
      if (running !== undefined) return running;
      const request = start(locale).finally(() => {
        pending.delete(locale);
      });
      pending.set(locale, request);
      return request;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The catalogues of the page: English is in the bundle, Vietnamese is its own chunk. */
export const catalogues: Catalogues = createCatalogues({
  initial: { en: enMessages },
  loaders: { vi: () => import('./messages/vi.ts').then((module) => module.viMessages) },
});

export function loadCatalogue(locale: Locale): Promise<boolean> {
  return catalogues.load(locale);
}

/** True for a key of the catalogue. Use it before building a key from data (`metric.<key>`). */
export function hasMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(enMessages, key);
}

export interface TranslateOptions {
  strict?: boolean;
}

/**
 * The text of `key` in `locale`, from the given catalogues; English where the locale has no such text. The untyped core of
 * `translate`, for code that holds its own catalogues.
 */
export function translateKey(
  source: Catalogues,
  locale: Locale,
  key: string,
  args: unknown,
  options: TranslateOptions = {},
): string {
  const strict = options.strict ?? STRICT;
  const own = source.messages(locale);
  const fallback = source.messages('en');
  const text =
    (own !== undefined && Object.hasOwn(own, key) ? own[key] : undefined) ??
    (fallback !== undefined && Object.hasOwn(fallback, key) ? fallback[key] : undefined);
  if (text === undefined) {
    if (strict) throw new Error(`Unknown message key: ${key}`);
    return key;
  }
  try {
    return formatMessage(text, isMessageArgs(args) ? args : undefined, locale, { strict });
  } catch (error) {
    if (strict || !(error instanceof MessageSyntaxError)) throw error;
    return text;
  }
}

/** The text of a message in a locale. Without a loaded catalogue for the locale the text is English. Usable outside React. */
export function translate<K extends MessageKey>(locale: Locale, key: K, ...args: ArgsTuple<K>): string {
  return translateKey(catalogues, locale, key, args[0]);
}

/** `translate` bound to a locale: the `t` of `useT()`. */
export function createT(locale: Locale, source: Catalogues = catalogues): TFunction {
  return (key, ...args) => translateKey(source, locale, key, args[0]);
}
