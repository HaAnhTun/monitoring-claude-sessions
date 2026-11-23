// The two words of `waiting_input` (ADR 0107, design attention-trust 4.1). The state is one, but it means two things: a
// session that cannot go on until a person decides or answers ("Needs you", rule family S-6), and a session whose turn is over
// with an empty prompt ("Ready for prompt", family S-8). The shared classifier tells them apart by the rule that decided the
// state. Without a rule, or with a rule the classifier cannot place, there is no override: the badge keeps the old word.
// Pure: no React.
import { attentionOf, type AttentionInput } from '@mcs/shared';

import type { StateDot, Tone, ToneClass } from './lifecycle-display.ts';

export type AttentionWord = 'needsYou' | 'ready';

export interface AttentionDisplay {
  word: AttentionWord;
  labelKey: `state.waiting_input.${AttentionWord}.label`;
  descriptionKey: `state.waiting_input.${AttentionWord}.description`;
  tone: Tone;
  toneClass: ToneClass;
  dot: StateDot;
}

const DISPLAYS: Readonly<Record<AttentionWord, AttentionDisplay>> = {
  // the tone and the ring of the state itself: this is the half that waits for a person
  needsYou: {
    word: 'needsYou',
    labelKey: 'state.waiting_input.needsYou.label',
    descriptionKey: 'state.waiting_input.needsYou.description',
    tone: 'waiting',
    toneClass: 'tone-waiting',
    dot: 'ring',
  },
  // the tone and the dot of "Turn ended": nothing is blocked
  ready: {
    word: 'ready',
    labelKey: 'state.waiting_input.ready.label',
    descriptionKey: 'state.waiting_input.ready.description',
    tone: 'idle',
    toneClass: 'tone-idle',
    dot: 'solid',
  },
};

/** What the override reads of an assessment; every part may be missing (a row of an older server, a synthetic row). */
export type AttentionDisplayInput = Partial<Pick<AttentionInput, 'rule' | 'waitReason' | 'turnOutcome'>>;

/** The override of the display of `state`, or `null`: the display of the lifecycle table stands. */
export function attentionDisplay(
  state: string,
  assessment: AttentionDisplayInput | null | undefined,
): AttentionDisplay | null {
  const rule = assessment?.rule;
  if (state !== 'waiting_input' || rule === undefined || rule === '') return null;
  const cls = attentionOf({
    state,
    rule,
    waitReason: assessment?.waitReason ?? null,
    turnOutcome: assessment?.turnOutcome ?? null,
  });
  if (cls.posture === 'needs_you') return DISPLAYS.needsYou;
  if (cls.posture === 'ready') return DISPLAYS.ready;
  return null;
}
