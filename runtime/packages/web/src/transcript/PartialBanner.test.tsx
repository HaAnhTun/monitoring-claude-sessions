import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { fmtMB } from '../lib/format.ts';
import { PartialBanner } from './PartialBanner.tsx';

describe('PartialBanner', () => {
  it('says how much is not indexed yet', () => {
    render(<PartialBanner partial pendingBytes={3_500_000} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      `Indexing this transcript: ${fmtMB(3_500_000)} not indexed yet; the newest entries may be missing`,
    );
  });

  it('renders nothing when the window is complete', () => {
    const { container } = render(<PartialBanner partial={false} pendingBytes={0} />);
    expect(container.childNodes).toHaveLength(0);
  });

  it('renders nothing when partial is set but no bytes are pending', () => {
    const { container } = render(<PartialBanner partial pendingBytes={0} />);
    expect(container.childNodes).toHaveLength(0);
  });
});
