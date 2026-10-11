import type { ReactNode } from 'react';

import { Button } from './Button.tsx';
import { Icon } from './Icon.tsx';
import type { IconName } from './icons.ts';

export interface EmptyStateProps {
  title: string;
  /** Causes and hints. */
  children?: ReactNode;
  action?: { label: string; onClick: () => void } | undefined;
  icon?: IconName | undefined;
}

export function EmptyState({ title, children, action, icon }: EmptyStateProps) {
  return (
    <div className="state state--empty" role="status">
      <p className="state__title">
        {icon === undefined ? null : <Icon name={icon} />}
        <span>{title}</span>
      </p>
      {children === undefined ? null : <div className="state__body">{children}</div>}
      {action === undefined ? null : (
        <div className="state__actions">
          <Button onClick={action.onClick}>{action.label}</Button>
        </div>
      )}
    </div>
  );
}
