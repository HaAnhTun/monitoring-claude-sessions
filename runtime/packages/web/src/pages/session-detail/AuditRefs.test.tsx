import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { iso } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { AuditRefs } from './AuditRefs.tsx';

describe('AuditRefs', () => {
  it('draws nothing without entries', () => {
    const { container } = renderWithIntl(<AuditRefs refs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the entries as text, named by their heading, with the file in words', () => {
    renderWithIntl(
      <AuditRefs
        refs={[
          { file: 'decisions', at: iso(-100), title: 'FIXTURE decision title', summary: 'FIXTURE <b>x</b>' },
          { file: 'changes', at: iso(-200), title: 'FIXTURE change title', summary: '' },
        ]}
      />,
    );
    const section = screen.getByRole('region', { name: msg('detail.auditRefs.title') });
    expect(within(section).getByRole('heading', { level: 2, name: msg('detail.auditRefs.title') })).toBeInTheDocument();
    expect(within(section).getAllByRole('listitem')).toHaveLength(2);
    expect(within(section).getByText('FIXTURE decision title')).toBeInTheDocument();
    expect(within(section).getByText('FIXTURE <b>x</b>')).toBeInTheDocument();
    expect(within(section).getByText(msg('detail.auditRefs.decisions'))).toBeInTheDocument();
    expect(within(section).getByText(msg('detail.auditRefs.changes'))).toBeInTheDocument();
    expect(section.querySelector('b')).toBeNull();
  });

  it('keeps an entry without a summary to its head line', () => {
    renderWithIntl(
      <AuditRefs refs={[{ file: 'changes', at: iso(-200), title: 'FIXTURE change title', summary: '' }]} />,
    );
    expect(document.querySelector('.audit-refs__summary')).toBeNull();
  });

  it('is worded in Vietnamese', () => {
    renderWithIntl(<AuditRefs refs={[{ file: 'decisions', at: iso(-1), title: 'FIXTURE t', summary: '' }]} />, {
      locale: 'vi',
    });
    expect(screen.getByRole('heading', { name: msg('detail.auditRefs.title', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByText(msg('detail.auditRefs.decisions', undefined, 'vi'))).toBeInTheDocument();
  });
});
