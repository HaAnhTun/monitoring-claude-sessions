// `msg(key, args?, locale = 'en')`: the text a user sees for a message of the catalogue (ADR 0072 decision 7). A test asserts
// `getByText(msg('state.working'))`, never a typed English or Vietnamese literal, so a wording change in the catalogue does not
// touch the tests and a test can run in both languages. Both catalogues are imported here (test code only), so the Vietnamese
// chunk of the app is not involved. A missing argument throws, which fails the test.
import { formatMessage, isMessageArgs } from '../i18n/format-message.ts';
import { enMessages } from '../i18n/messages/en.ts';
import { viMessages } from '../i18n/messages/vi.ts';
import type { EnglishMessages, Locale, MessageArgs, MessageKey, Messages, PlaceholderNames } from '../i18n/types.ts';

type MsgRest<K extends MessageKey> = [PlaceholderNames<EnglishMessages[K]>] extends [never]
  ? [args?: undefined, locale?: Locale]
  : [args: MessageArgs<K>, locale?: Locale];

export function msg<K extends MessageKey>(key: K, ...rest: MsgRest<K>): string;
export function msg(key: MessageKey, args?: unknown, locale: Locale = 'en'): string {
  const source: Messages = locale === 'vi' ? viMessages : enMessages;
  const text = Object.hasOwn(source, key) ? source[key] : undefined;
  if (text === undefined) throw new Error(`Unknown message key: ${key}`);
  return formatMessage(text, isMessageArgs(args) ? args : undefined, locale);
}
