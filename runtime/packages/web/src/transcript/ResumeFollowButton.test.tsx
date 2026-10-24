import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { ResumeFollowButton } from './ResumeFollowButton.tsx';

describe('ResumeFollowButton', () => {
  it('shows the number of unseen events', () => {
    renderWithIntl(<ResumeFollowButton unseen={7} onResume={() => undefined} />);
    expect(screen.getByRole('button', { name: msg('transcript.resumeNew', { count: 7 }) })).toBeInTheDocument();
  });

  it('omits the count when nothing is unseen', () => {
    renderWithIntl(<ResumeFollowButton unseen={0} onResume={() => undefined} />);
    expect(screen.getByRole('button', { name: msg('transcript.resume') })).toBeInTheDocument();
  });

  it('speaks Vietnamese', () => {
    renderWithIntl(<ResumeFollowButton unseen={2} onResume={() => undefined} />, { locale: 'vi' });
    expect(screen.getByRole('button', { name: msg('transcript.resumeNew', { count: 2 }, 'vi') })).toBeInTheDocument();
  });

  it('resumes on click', async () => {
    const onResume = vi.fn();
    renderWithIntl(<ResumeFollowButton unseen={1} onResume={onResume} />);
    await userEvent.setup().click(screen.getByRole('button'));
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
