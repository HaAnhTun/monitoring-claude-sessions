import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { Icon } from './Icon.tsx';
import type { IconName } from './icons.ts';

export type ButtonVariant = 'default' | 'primary' | 'quiet' | 'icon';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'className'> {
  variant?: ButtonVariant;
  icon?: IconName;
  loading?: boolean;
  type?: 'button' | 'submit' | 'reset';
  children?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: 'btn',
  primary: 'btn btn-primary',
  quiet: 'btn btn-quiet',
  icon: 'btn btn-icon',
};

export function Button({
  variant = 'default',
  icon,
  loading = false,
  type = 'button',
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const className = loading ? `${VARIANT_CLASS[variant]} is-loading` : VARIANT_CLASS[variant];
  return (
    <button
      {...rest}
      type={type}
      className={className}
      disabled={disabled === true || loading}
      aria-busy={loading ? true : undefined}
    >
      {icon === undefined ? null : <Icon name={icon} />}
      {children}
    </button>
  );
}
