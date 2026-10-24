import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createFormatters } from '../i18n/format.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { PartialBanner } from './PartialBanner.tsx';

describe('PartialBanner', () => {
  it('says how much is not indexed yet', () => {
    renderWithIntl(<PartialBanner partial pendingBytes={3_500_000} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      msg('transcript.partial', { size: createFormatters('en').bytes(3_500_000) }),
    );
  });

  it('words the size in the language of the page', () => {
    renderWithIntl(<PartialBanner partial pendingBytes={3_500_000} />, { locale: 'vi' });
    expect(screen.getByRole('status')).toHaveTextContent(
      msg('transcript.partial', { size: createFormatters('vi').bytes(3_500_000) }, 'vi'),
    );
  });

  it('renders nothing when the window is complete', () => {
    const { container } = renderWithIntl(<PartialBanner partial={false} pendingBytes={0} />);
    expect(container.childNodes).toHaveLength(0);
  });

  it('renders nothing when partial is set but no bytes are pending', () => {
    const { container } = renderWithIntl(<PartialBanner partial pendingBytes={0} />);
    expect(container.childNodes).toHaveLength(0);
  });
});
