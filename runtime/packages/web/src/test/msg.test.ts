// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { enMessages } from '../i18n/messages/en.ts';
import { viMessages } from '../i18n/messages/vi.ts';
import { msg } from './msg.ts';

describe('msg', () => {
  it('is the English text by default', () => {
    expect(msg('common.close')).toBe(enMessages['common.close']);
    expect(msg('common.retry', undefined, 'en')).toBe(enMessages['common.retry']);
  });

  it('is the Vietnamese text for vi', () => {
    expect(msg('common.close', undefined, 'vi')).toBe(viMessages['common.close']);
    expect(msg('lang.vi', undefined, 'vi')).toBe(viMessages['lang.vi']);
  });

  it('differs between the languages for a translated message', () => {
    expect(msg('common.close', undefined, 'vi')).not.toBe(msg('common.close'));
  });

  it('refuses arguments for a message that has none and an unknown key, at compile time', () => {
    // @ts-expect-error a message without placeholders takes no arguments
    expect(msg('common.close', { count: 1 })).toBe(enMessages['common.close']);
    // @ts-expect-error unknown key
    expect(() => msg('common.doesNotExist')).toThrow();
  });
});
