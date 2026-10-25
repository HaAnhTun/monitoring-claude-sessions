import { useId } from 'react';

import { useT } from '../i18n/context.ts';

export interface MeterProps {
  /** What is measured ("Memory"); the accessible name of the meter. */
  label: string;
  /** The value as a percentage; a value outside 0 to 100 is drawn at the nearest end. */
  pct: number;
  /** The value in words ("6.7 of 16 GB"); shown at the end of the head and read by assistive technology. */
  valueText: string;
  /** Above this percentage the meter gets a High tag and the failed colour. */
  highAbove?: number;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * A horizontal gauge from 0 to 100 (ADR 0073 decision 9, the Machine panel): label and value on top, a thin bar below. The bar is
 * the element with `role="meter"`. Past `highAbove` the word High appears beside the label, so the warning is never colour alone.
 */
export function Meter({ label, pct, valueText, highAbove }: MeterProps) {
  const t = useT();
  const labelId = useId();
  const value = clamp(pct);
  const high = highAbove !== undefined && value > highAbove;
  return (
    <div className="meter" data-high={high ? 'true' : undefined}>
      <div className="meter__head">
        <span id={labelId} className="meter__label">
          {label}
        </span>
        {high ? <span className="meter__high">{t('panels.meter.high')}</span> : null}
        <span className="meter__value">{valueText}</span>
      </div>
      <div
        className="meter__track"
        role="meter"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={valueText}
        data-high={high ? 'true' : undefined}
      >
        <span className="meter__fill" style={{ inlineSize: `${String(value)}%` }} />
      </div>
    </div>
  );
}
