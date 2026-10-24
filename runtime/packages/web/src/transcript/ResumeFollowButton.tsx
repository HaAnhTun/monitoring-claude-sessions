import { Button } from '../components/Button.tsx';
import { useT } from '../i18n/context.ts';

export interface ResumeFollowButtonProps {
  /** Events that arrived while following was off. */
  unseen: number;
  onResume: () => void;
}

/** Floats at the latest edge while follow is off: "Resume following (N new)". */
export function ResumeFollowButton({ unseen, onResume }: ResumeFollowButtonProps) {
  const t = useT();
  return (
    <div className="tv-resume">
      <Button variant="primary" icon="arrow-down" onClick={onResume}>
        {unseen > 0 ? t('transcript.resumeNew', { count: unseen }) : t('transcript.resume')}
      </Button>
    </div>
  );
}
