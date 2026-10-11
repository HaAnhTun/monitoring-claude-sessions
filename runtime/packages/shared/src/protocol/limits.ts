/**
 * The single line-length cap shared by the tailer, `readEntryText` and the transcript window and search
 * (02 1.1, 5.3, 5.7; 03 7). A constant, never a configuration key (I-32, C01): 64 MiB.
 */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;
