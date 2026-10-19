import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnnouncerProvider } from '../state/announcer.tsx';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { CopyButton } from './CopyButton.tsx';

function renderButton(ui: ReactElement) {
  return renderWithIntl(<AnnouncerProvider>{ui}</AnnouncerProvider>);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CopyButton', () => {
  it('copies through the async clipboard in a secure context and says so', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    const onResult = vi.fn();
    renderButton(
      <CopyButton
        text="the text"
        label="Copy tool input"
        clipboard={{ clipboard: { writeText }, isSecureContext: true }}
        onResult={onResult}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Copy tool input' }));
    expect(writeText).toHaveBeenCalledWith('the text');
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(msg('common.copied'));
    });
    expect(onResult).toHaveBeenCalledWith(true, msg('common.copied'));
  });

  it('reads a text function at click time', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    let current = 'before';
    renderButton(
      <CopyButton
        text={() => current}
        label="Copy it"
        clipboard={{ clipboard: { writeText }, isSecureContext: true }}
      />,
    );
    current = 'after';
    await user.click(screen.getByRole('button', { name: 'Copy it' }));
    expect(writeText).toHaveBeenCalledWith('after');
  });

  it('uses the text area fallback when the context is not secure', async () => {
    const execCopy = vi.fn(() => true);
    const writeText = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    renderButton(
      <CopyButton
        text="fallback"
        label="Copy it"
        clipboard={{ clipboard: { writeText }, isSecureContext: false, execCopy }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Copy it' }));
    expect(writeText).not.toHaveBeenCalled();
    expect(execCopy).toHaveBeenCalledWith('fallback');
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(msg('common.copied'));
    });
  });

  it('works through the browser globals with the document.execCommand fallback', async () => {
    vi.stubGlobal('isSecureContext', false);
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true, writable: true });
    const user = userEvent.setup();
    renderButton(<CopyButton text="via globals" label="Copy it" />);
    await user.click(screen.getByRole('button', { name: 'Copy it' }));
    expect(exec).toHaveBeenCalledWith('copy');
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(msg('common.copied'));
    });
  });

  it('announces a failure with the manual hint', async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    renderButton(
      <CopyButton
        text="x"
        label="Copy it"
        clipboard={{ isSecureContext: false, execCopy: () => false }}
        onResult={onResult}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Copy it' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(msg('common.copyFailed'));
    });
    expect(onResult).toHaveBeenCalledWith(false, msg('common.copyFailed'));
  });

  it('shows custom visible content and the compact style', () => {
    renderButton(
      <CopyButton text="x" label="Copy event index" compact>
        #12
      </CopyButton>,
    );
    const button = screen.getByRole('button', { name: 'Copy event index' });
    expect(button).toHaveTextContent('#12');
    expect(button).toHaveClass('copy-btn--compact');
  });

  it('clears the visible confirmation after a moment', async () => {
    vi.useFakeTimers();
    renderButton(<CopyButton text="x" label="Copy it" clipboard={{ isSecureContext: false, execCopy: () => true }} />);
    const button = screen.getByRole('button', { name: 'Copy it' });
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(button).toHaveTextContent(msg('common.copied'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(button).toHaveTextContent(msg('common.copy'));
    expect(button).not.toHaveTextContent(msg('common.copied'));
  });

  it('works outside the announcer provider and still reports through onResult', async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    renderWithIntl(
      <CopyButton
        text="x"
        label="Copy it"
        clipboard={{ isSecureContext: false, execCopy: () => true }}
        onResult={onResult}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Copy it' }));
    expect(onResult).toHaveBeenCalledWith(true, msg('common.copied'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders no live region of its own, so a long transcript has exactly one', () => {
    const { container } = renderButton(
      <>
        <CopyButton text="a" label="Copy a" />
        <CopyButton text="b" label="Copy b" />
      </>,
    );
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('shows its default text and its confirmation in the language of the page', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <CopyButton text="x" label="Copy it" clipboard={{ isSecureContext: false, execCopy: () => true }} />,
      { locale: 'vi' },
    );
    const button = screen.getByRole('button', { name: 'Copy it' });
    expect(button).toHaveTextContent(msg('common.copy', undefined, 'vi'));
    await user.click(button);
    expect(button).toHaveTextContent(msg('common.copied', undefined, 'vi'));
  });
});
