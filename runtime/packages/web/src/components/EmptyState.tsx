import type { ReactNode, Ref } from 'react';

import { Button } from './Button.tsx';
import { Icon } from './Icon.tsx';
import type { IconName } from './icons.ts';

export interface EmptyStateProps {
  title: string;
  /** Causes and hints. */
  children?: ReactNode;
  /** The one primary button of the state ("Clear filters"); at most one primary button per screen (ADR 0071 decision 7). */
  primary?: { label: string; onClick: () => void } | undefined;
  /** Other ways out, after the primary button (a link, a quiet button). */
  secondary?: ReactNode;
  icon?: IconName | undefined;
  /** The title is a heading of this level (the page heading is 1). */
  headingLevel?: 1 | 2 | 3 | undefined;
  /** Ref of that heading, for the focus that follows a navigation. */
  titleRef?: Ref<HTMLHeadingElement> | undefined;
  /** A polite status region (the default). A state that is the whole page turns it off: the page is the announcement. */
  announce?: boolean | undefined;
}

function Title({
  text,
  level,
  titleRef,
}: {
  text: string;
  level: EmptyStateProps['headingLevel'];
  titleRef: EmptyStateProps['titleRef'];
}) {
  if (level === undefined) return <span>{text}</span>;
  const Tag = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
  return (
    <Tag ref={titleRef} tabIndex={-1} className="state__heading">
      {text}
    </Tag>
  );
}

export function EmptyState({
  title,
  children,
  primary,
  secondary,
  icon,
  headingLevel,
  titleRef,
  announce = true,
}: EmptyStateProps) {
  return (
    <div className="state state--empty" role={announce ? 'status' : undefined}>
      <div className="state__title">
        {icon === undefined ? null : <Icon name={icon} />}
        <Title text={title} level={headingLevel} titleRef={titleRef} />
      </div>
      {children === undefined ? null : <div className="state__body">{children}</div>}
      {primary === undefined && secondary === undefined ? null : (
        <div className="state__actions">
          {primary === undefined ? null : (
            <Button variant="primary" onClick={primary.onClick}>
              {primary.label}
            </Button>
          )}
          {secondary}
        </div>
      )}
    </div>
  );
}
