import { Button } from '../components/Button.tsx';

export interface ResumeFollowButtonProps {
  /** Events that arrived while following was off. */
  unseen: number;
  onResume: () => void;
}

/** Floats at the latest edge while follow is off: "Resume following (N new)". */
export function ResumeFollowButton({ unseen, onResume }: ResumeFollowButtonProps) {
  return (
    <div className="tv-resume">
      <Button variant="primary" icon="arrow-down" onClick={onResume}>
        {unseen > 0 ? `Resume following (${String(unseen)} new)` : 'Resume following'}
      </Button>
    </div>
  );
}
