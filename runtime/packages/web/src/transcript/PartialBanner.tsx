import { fmtMB } from '../lib/format.ts';

export interface PartialBannerProps {
  partial: boolean;
  /** Bytes of the transcript file that are not indexed yet (03 7.3). */
  pendingBytes: number;
}

/** Shown while the server has not indexed the whole file: the newest entries may be missing (04-ui.md 4.4.3 step 10). */
export function PartialBanner({ partial, pendingBytes }: PartialBannerProps) {
  if (!partial || pendingBytes <= 0) return null;
  return (
    <p className="tv-banner tv-banner--partial" role="status">
      {`Indexing this transcript: ${fmtMB(pendingBytes)} not indexed yet; the newest entries may be missing`}
    </p>
  );
}
