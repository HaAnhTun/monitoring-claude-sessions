import { ICONS, type IconName } from './icons.ts';

export interface IconProps {
  name: IconName;
  className?: string;
}

/** Decorative icon: the accessible name always comes from adjacent text or the button's aria-label (04-ui.md 6.4). */
export function Icon({ name, className }: IconProps) {
  const Component = ICONS[name];
  return (
    <Component
      className={className === undefined ? 'icon' : `icon ${className}`}
      aria-hidden="true"
      focusable="false"
      size="1.1em"
      strokeWidth={2}
    />
  );
}
