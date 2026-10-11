// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { copyText, type ClipboardDeps } from './clipboard.ts';

function setup(over: Partial<ClipboardDeps> = {}) {
  const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  const execCopy = vi.fn<(text: string) => boolean>(() => true);
  const deps: ClipboardDeps = { clipboard: { writeText }, isSecureContext: true, execCopy, ...over };
  return { deps, writeText, execCopy };
}

describe('copyText', () => {
  it('uses the async clipboard in a secure context', async () => {
    const { deps, writeText, execCopy } = setup();
    await expect(copyText('hello', deps)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(execCopy).not.toHaveBeenCalled();
  });

  it('falls back to the text area copy when the page is not a secure context', async () => {
    const { deps, writeText, execCopy } = setup({ isSecureContext: false });
    await expect(copyText('hello', deps)).resolves.toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(execCopy).toHaveBeenCalledWith('hello');
  });

  it('falls back when there is no clipboard object', async () => {
    const { deps, execCopy } = setup({ clipboard: undefined });
    await expect(copyText('x', deps)).resolves.toBe(true);
    expect(execCopy).toHaveBeenCalledWith('x');
  });

  it('falls back when the async clipboard rejects', async () => {
    const rejecting = { writeText: vi.fn(() => Promise.reject(new Error('denied'))) };
    const { deps, execCopy } = setup({ clipboard: rejecting });
    await expect(copyText('x', deps)).resolves.toBe(true);
    expect(rejecting.writeText).toHaveBeenCalledTimes(1);
    expect(execCopy).toHaveBeenCalledWith('x');
  });

  it('reports failure when the fallback fails or throws', async () => {
    await expect(copyText('x', setup({ isSecureContext: false, execCopy: vi.fn(() => false) }).deps)).resolves.toBe(
      false,
    );
    const throwing = vi.fn(() => {
      throw new Error('blocked');
    });
    await expect(copyText('x', setup({ isSecureContext: false, execCopy: throwing }).deps)).resolves.toBe(false);
  });

  it('reports failure when nothing can copy', async () => {
    await expect(copyText('x', { clipboard: undefined, isSecureContext: false })).resolves.toBe(false);
  });

  it('without a DOM the default dependencies fail closed instead of throwing', async () => {
    await expect(copyText('x')).resolves.toBe(false);
  });
});
