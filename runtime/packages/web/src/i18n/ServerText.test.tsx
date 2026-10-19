import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../test/render.tsx';
import { ServerText } from './ServerText.tsx';

const SERVER = 'FIXTURE evidence: last record 18m ago';

describe('ServerText', () => {
  it('renders the text without a lang attribute when the UI is English', () => {
    renderWithIntl(<ServerText>{SERVER}</ServerText>, { locale: 'en' });
    const element = screen.getByText(SERVER);
    expect(element.tagName).toBe('SPAN');
    expect(element).not.toHaveAttribute('lang');
  });

  it('marks the text as English when the UI is Vietnamese', () => {
    renderWithIntl(<ServerText>{SERVER}</ServerText>, { locale: 'vi' });
    expect(screen.getByText(SERVER)).toHaveAttribute('lang', 'en');
  });

  it('is English and unmarked without a provider', () => {
    render(<ServerText>{SERVER}</ServerText>);
    expect(screen.getByText(SERVER)).not.toHaveAttribute('lang');
  });

  it('can be a paragraph, a block or a list item and takes a class name', () => {
    renderWithIntl(
      <>
        <ServerText as="p" className="muted">
          {SERVER}
        </ServerText>
        <ServerText as="div">{`${SERVER} two`}</ServerText>
        <ul>
          <ServerText as="li">{`${SERVER} three`}</ServerText>
        </ul>
      </>,
      { locale: 'vi' },
    );
    const paragraph = screen.getByText(SERVER);
    expect(paragraph.tagName).toBe('P');
    expect(paragraph).toHaveClass('muted');
    expect(paragraph).toHaveAttribute('lang', 'en');
    expect(screen.getByText(`${SERVER} two`).tagName).toBe('DIV');
    expect(screen.getByText(`${SERVER} three`).tagName).toBe('LI');
  });

  it('shows markup in the text as text', () => {
    renderWithIntl(<ServerText>{'<b>bold</b> & {braces}'}</ServerText>, { locale: 'vi' });
    expect(screen.getByText('<b>bold</b> & {braces}')).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
  });
});
