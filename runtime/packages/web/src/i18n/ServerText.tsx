import { useI18n } from './context.ts';

export interface ServerTextProps {
  /** The text as the server sent it. It is English and is never translated (ADR 0072 decision 5). */
  children: string;
  as?: 'span' | 'p' | 'div' | 'li';
  className?: string;
}

/**
 * Text that comes from the server (metric sources and rules, evidence, alert titles, panel messages, error envelopes). It is
 * English; when the UI is in another language the element says `lang="en"`, so a screen reader reads it with an English voice and
 * the browser hyphenates and quotes it as English. The wording around it is the UI's own and is translated.
 */
export function ServerText({ children, as: Tag = 'span', className }: ServerTextProps) {
  const { locale } = useI18n();
  return (
    <Tag className={className} lang={locale === 'en' ? undefined : 'en'}>
      {children}
    </Tag>
  );
}
