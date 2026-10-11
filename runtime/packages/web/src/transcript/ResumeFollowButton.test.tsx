import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ResumeFollowButton } from './ResumeFollowButton.tsx';

describe('ResumeFollowButton', () => {
  it('shows the number of unseen events', () => {
    render(<ResumeFollowButton unseen={7} onResume={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Resume following (7 new)' })).toBeInTheDocument();
  });

  it('omits the count when nothing is unseen', () => {
    render(<ResumeFollowButton unseen={0} onResume={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Resume following' })).toBeInTheDocument();
  });

  it('resumes on click', async () => {
    const onResume = vi.fn();
    render(<ResumeFollowButton unseen={1} onResume={onResume} />);
    await userEvent.setup().click(screen.getByRole('button'));
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
