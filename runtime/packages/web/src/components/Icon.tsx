import { ICONS, type IconName } from './icons.ts';

/** Icons are 16 px with a 1.5 stroke; `menu` is the 18 px size of a menu or navigation entry (ADR 0071 decision 9). */
export type IconSize = 'default' | 'menu';

const PIXELS: Record<IconSize, number> = { default: 16, menu: 18 };
const STROKE = 1.5;

export interface IconProps {
  name: IconName;
  className?: string;
  size?: IconSize;
}

/** Decorative icon: the accessible name always comes from adjacent text or the button's aria-label (04-ui.md 6.4). */
export function Icon({ name, className, size = 'default' }: IconProps) {
  const Component = ICONS[name];
  return (
    <Component
      className={className === undefined ? 'icon' : `icon ${className}`}
      aria-hidden="true"
      focusable="false"
      size={PIXELS[size]}
      strokeWidth={STROKE}
    />
  );
}
