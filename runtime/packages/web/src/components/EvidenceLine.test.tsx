import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createFormatters } from '../i18n/format.ts';
import { FIXTURE_NOW_MS, iso, makeState } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { EvidenceLine } from './EvidenceLine.tsx';

const NOW = FIXTURE_NOW_MS;
const TOOL_TEXT = 'FIXTURE tool Bash open for 5m';

function toolState() {
  return makeState('waiting_tool', {
    evidence: [{ kind: 'transcript:tool_open', at: iso(-300), text: TOOL_TEXT }],
  });
}

describe('EvidenceLine', () => {
  it('composes "inferred, quiet 18m" from the clock for an inferred active turn', () => {
    const state = makeState('working', { basis: 'inferred', confidence: 'medium' });
    const { container } = renderWithIntl(
      <EvidenceLine assessment={state} lastActivityAt={iso(-18 * 60)} nowMs={NOW} />,
    );
    const line = container.querySelector('.evidence-line');
    expect(line).toHaveTextContent(msg('evidence.inferredQuiet', { age: '18m' }));
    expect(line).toHaveAttribute(
      'title',
      msg('evidence.basisTip', {
        basis: msg('evidence.basis.inferredSilence'),
        confidence: msg('evidence.confidence.medium'),
      }),
    );
  });

  it('says it in Vietnamese with the Vietnamese words, without a lang mark (the UI text is translated)', () => {
    const state = makeState('running', { basis: 'inferred' });
    const { container } = renderWithIntl(
      <EvidenceLine assessment={state} lastActivityAt={iso(-5 * 60)} nowMs={NOW} />,
      {
        locale: 'vi',
      },
    );
    const line = container.querySelector('.evidence-line');
    expect(line).toHaveTextContent(msg('evidence.inferredQuiet', { age: createFormatters('vi').age(300) }, 'vi'));
    expect(line).not.toHaveAttribute('lang');
  });

  it('marks the server line as English under the Vietnamese UI', () => {
    renderWithIntl(<EvidenceLine assessment={toolState()} lastActivityAt={iso(-300)} nowMs={NOW} />, { locale: 'vi' });
    expect(screen.getByText(TOOL_TEXT)).toHaveAttribute('lang', 'en');
  });

  it('leaves the server line unmarked under the English UI', () => {
    renderWithIntl(<EvidenceLine assessment={toolState()} lastActivityAt={iso(-300)} nowMs={NOW} />);
    expect(screen.getByText(TOOL_TEXT)).not.toHaveAttribute('lang');
  });

  it('renders nothing for an observed state', () => {
    const { container } = renderWithIntl(
      <EvidenceLine assessment={makeState('working')} lastActivityAt={iso(-18 * 60)} nowMs={NOW} />,
    );
    expect(container.querySelector('.evidence-line')).toBeNull();
  });

  it('says only "inferred" when the state is inferred and nothing else is known', () => {
    const state = makeState('unknown', { basis: 'inferred', confidence: 'low' });
    const { container } = renderWithIntl(<EvidenceLine assessment={state} nowMs={NOW} />);
    expect(container.querySelector('.evidence-line')).toHaveTextContent(msg('evidence.inferred'));
  });

  it('reads the shared clock when no time is given', () => {
    const state = makeState('working', { basis: 'inferred' });
    const { container } = renderWithIntl(
      <EvidenceLine assessment={state} lastActivityAt={new Date(Date.now() - 120_000).toISOString()} />,
    );
    expect(container.querySelector('.evidence-line')).toHaveTextContent(msg('evidence.inferredQuiet', { age: '2m' }));
  });

  it('bounds the line to a width in ch, so a long server text cannot stretch an auto-layout table column', () => {
    // jsdom has no layout; the rule is read from the stylesheet. A per cent width does not clamp a no-wrap line in a table cell
    // (it sets the column's minimum width), so the bound must be an absolute one (probe: 88 characters made the column 543 px).
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'badges.css'), 'utf8');
    const rule = /\.evidence-line\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/max-width:\s*\d+ch\s*;/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('keeps the full text of a long server line in the title', () => {
    const long = 'tool mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot open (2 open) for 5m';
    const state = makeState('waiting_tool', {
      evidence: [{ kind: 'transcript:tool_open', at: iso(-300), text: long }],
    });
    const { container } = renderWithIntl(<EvidenceLine assessment={state} nowMs={NOW} />);
    expect(container.querySelector('.evidence-line')?.getAttribute('title')).toContain(long);
  });
});
