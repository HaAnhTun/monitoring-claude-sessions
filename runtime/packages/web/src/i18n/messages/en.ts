// The English catalogue: the source of truth for the message keys and for the placeholders of every message (ADR 0072).
//
// One flat object, dotted keys that start with the owning feature (`common.`, `lang.`, `state.`, `shell.`, ...). A value is
// plain text in a small ICU subset: `{name}` interpolates an argument, and
// `{count, plural, =0 {no errors} one {# error} other {# errors}}` picks a form by the number (`#` prints it, `other` is
// required, no nesting, no `select`, no literal braces). Apostrophes and quotes are ordinary characters.
//
// This file stays ASCII (the text gate allows Vietnamese letters in `vi.ts` only), so a language name that needs them lives in
// `vi.ts`. Every UI work package adds its entries between its own markers; do not move a marker or touch another block.
// Add the same keys to `vi.ts` in the same change: the catalogue test compares the two files.
export const enMessages = {
  'common.close': 'Close',
  'common.retry': 'Retry',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.loading': 'Loading...',
  'common.notAvailable': 'Not available',
  'common.viewFailed': 'This view failed to render.',
  'common.reloadPage': 'Reload page',
  'lang.auto': 'Automatic',
  'lang.en': 'English',
  'lang.vi': 'Vietnamese',
  // @wp-begin WP-53
  // @wp-end WP-53
  // @wp-begin WP-54
  // @wp-end WP-54
  // @wp-begin WP-65
  // @wp-end WP-65
  // @wp-begin WP-66
  // @wp-end WP-66
  // @wp-begin WP-67
  // @wp-end WP-67
  // @wp-begin WP-112
  // @wp-end WP-112
  // @wp-begin WP-113
  // @wp-end WP-113
  // @wp-begin WP-114
  // @wp-end WP-114
  // @wp-begin WP-115
  // @wp-end WP-115
  // @wp-begin WP-116
  // @wp-end WP-116
  // @wp-begin WP-117
  // @wp-end WP-117
  // @wp-begin WP-118
  // @wp-end WP-118
  // @wp-begin WP-119
  // @wp-end WP-119
  // @wp-begin WP-120
  // @wp-end WP-120
  // @wp-begin WP-121
  // @wp-end WP-121
  // @wp-begin WP-124
  // @wp-end WP-124
} as const;
