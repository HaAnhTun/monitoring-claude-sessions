import { useLayoutEffect, useRef, type RefObject, type UIEvent } from 'react';

import { RelativeTime } from '../components/RelativeTime.tsx';
import { useT } from '../i18n/context.ts';
import { PanelNote, type PanelBodyProps } from './PanelFrame.tsx';

/** How far from the bottom (in pixels) a reader may be and still count as following the tail. */
export const STICK_TOLERANCE_PX = 8;

export interface StickToBottom {
  /** Goes on the scrolling element: it records whether the reader is at the bottom. */
  onScroll: (event: UIEvent<HTMLElement>) => void;
}

/**
 * Keeps a tail at its bottom while new text arrives, but only for a reader who is at the bottom (within 8 px). A reader who
 * scrolled up to look at older lines is not pulled down. The first draw starts at the bottom.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, content: string): StickToBottom {
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
  }, [ref, content]);
  return {
    onScroll: (event) => {
      const element = event.currentTarget;
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_TOLERANCE_PX;
    },
  };
}

/** The last lines of the chain log, as a scrolling region that follows new lines while the reader is at the bottom. */
export function ChainLogPanel({ data }: PanelBodyProps<'chainLog'>) {
  const t = useT();
  const ref = useRef<HTMLPreElement>(null);
  const text = data.lines.join('\n');
  const { onScroll } = useStickToBottom(ref, text);
  if (data.lines.length === 0) return <PanelNote>{t('panels.chainLog.empty')}</PanelNote>;
  return (
    <div className="panel-chain-log">
      <pre
        ref={ref}
        className="panel-tail mono"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling text region must take focus so that a keyboard user can scroll it (04-ui.md 4.4.1)
        tabIndex={0}
        role="region"
        aria-label={t('panels.chainLog.tail')}
        onScroll={onScroll}
      >
        {text}
      </pre>
      {data.file === null ? null : (
        <p className="panel-meta muted">
          <span className="panel-meta__file mono" title={data.file}>
            {data.file}
          </span>
          {data.modifiedAt === null ? null : <RelativeTime iso={data.modifiedAt} />}
        </p>
      )}
    </div>
  );
}
