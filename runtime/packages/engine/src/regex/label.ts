// Label template of a session rule (design 01 section 2.8).
import type { RegexMatch } from './types.ts';

const LABEL_WHOLE_MATCH_LIMIT = 40;

/**
 * For each group `i = 1..n` replace every `{i}` with the group text (empty when the group did not take part), one
 * group after the other, so text that group 1 produced is searched for `{2}` again. Then replace `{0}` with the first 40
 * code points of the whole match. Splitting avoids the special `$` patterns of string replace.
 */
export function applyLabelTemplate(template: string, m: RegexMatch): string {
  let label = template;
  m.groups().forEach((text, index) => {
    label = label.split(`{${String(index + 1)}}`).join(text ?? '');
  });
  const head = Array.from(m.group(0) ?? '')
    .slice(0, LABEL_WHOLE_MATCH_LIMIT)
    .join('');
  return label.split('{0}').join(head);
}
