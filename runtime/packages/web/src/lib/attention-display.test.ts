// @vitest-environment node
import { ATTENTION_RULES, LIFECYCLE_STATES } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { enMessages } from '../i18n/messages/en.ts';
import { viMessages } from '../i18n/messages/vi.ts';
import { attentionDisplay } from './attention-display.ts';

describe('attentionDisplay: the two words of waiting_input', () => {
  it.each([
    ['S-6a', 'permission'],
    ['S-6b', 'user'],
    ['S-6c', 'elicitation'],
  ] as const)('%s reads "Needs you" with the waiting tone and the ring', (rule, waitReason) => {
    const display = attentionDisplay('waiting_input', { rule, waitReason });
    expect(display).toMatchObject({ word: 'needsYou', tone: 'waiting', toneClass: 'tone-waiting', dot: 'ring' });
    expect(display === null ? null : enMessages[display.labelKey]).toBe('Needs you');
  });

  it.each(['S-8b', 'S-8c', 'S-8f'])('%s reads "Ready for prompt" with the idle tone and a solid dot', (rule) => {
    const display = attentionDisplay('waiting_input', { rule, waitReason: 'user' });
    expect(display).toMatchObject({ word: 'ready', tone: 'idle', toneClass: 'tone-idle', dot: 'solid' });
    expect(display === null ? null : enMessages[display.labelKey]).toBe('Ready for prompt');
  });

  it('keeps the old label without a rule and with a rule the classifier cannot place', () => {
    for (const assessment of [undefined, null, {}, { rule: '' }, { rule: 'S-1' }, { rule: 'S-5' }, { rule: 'X-99' }]) {
      expect(attentionDisplay('waiting_input', assessment), JSON.stringify(assessment)).toBeNull();
    }
  });

  it('never overrides another state, whatever rule it carries', () => {
    for (const state of LIFECYCLE_STATES.filter((candidate) => candidate !== 'waiting_input')) {
      for (const rule of Object.keys(ATTENTION_RULES)) expect(attentionDisplay(state, { rule }), state).toBeNull();
    }
    expect(attentionDisplay('not a state', { rule: 'S-6a' })).toBeNull();
  });

  it('has both words and both descriptions in English and in Vietnamese', () => {
    for (const rule of ['S-6a', 'S-8b']) {
      const display = attentionDisplay('waiting_input', { rule });
      if (display === null) throw new Error(`no display for ${rule}`);
      for (const key of [display.labelKey, display.descriptionKey]) {
        expect(enMessages[key], key).not.toBe('');
        expect(viMessages[key], key).not.toBe(enMessages[key]);
      }
    }
    expect(enMessages['state.waiting_input.label']).toBe('Waiting for input');
  });
});
