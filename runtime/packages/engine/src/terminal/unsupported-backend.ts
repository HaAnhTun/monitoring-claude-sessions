// The backend of a host that cannot run the terminal (design 01 sections 3.11 and 6): it says why, and `spawn` throws the
// matching TerminalError. The service reports `supported: false` with the reason, the UI says "not supported on this OS".
import { TerminalError, type TerminalErrorCode } from './errors.ts';
import type { PtyBackend, TerminalSupport, UnsupportedReason } from './types.ts';

/** The error code of a refused spawn, per reason. A build of Windows that is too old is an unsupported operating system. */
const CODE_OF_REASON: Readonly<Record<UnsupportedReason, TerminalErrorCode>> = {
  'unsupported-os': 'UNSUPPORTED_OS',
  'os-too-old': 'UNSUPPORTED_OS',
  'native-missing': 'NATIVE_MISSING',
  'native-load-failed': 'NATIVE_LOAD_FAILED',
};

/** The reason that a backend error code stands for, or null for a code that is not about the backend. */
export function unsupportedReasonOf(code: TerminalErrorCode): UnsupportedReason | null {
  if (code === 'UNSUPPORTED_OS') return 'unsupported-os';
  if (code === 'NATIVE_MISSING') return 'native-missing';
  if (code === 'NATIVE_LOAD_FAILED') return 'native-load-failed';
  return null;
}

export class UnsupportedBackend implements PtyBackend {
  readonly name = 'unsupported';
  readonly support: TerminalSupport;
  readonly reason: UnsupportedReason;

  constructor(reason: UnsupportedReason) {
    this.reason = reason;
    this.support = { supported: false, reason };
  }

  /** Always throws: there is nothing to start a process with. */
  readonly spawn: PtyBackend['spawn'] = () => {
    throw new TerminalError(CODE_OF_REASON[this.reason]);
  };
}
