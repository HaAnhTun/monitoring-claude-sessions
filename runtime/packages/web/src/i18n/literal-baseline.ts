// The ratchet of the literal-text audit (ADR 0072 decision 6, `no-literal-text.test.ts`): the source files that still hold
// user-facing text written in the code, as paths relative to `src/`. A work package that converts a file to the catalogue deletes
// its line from its own block in the same change; the test fails for a listed file that has no violation left and for a violation
// in a file that is not listed. The list must be empty when the last UI work package lands.
//
// One block per work package, entries only (strings, one per line, each ending with a comma); do not move a marker or touch another
// block. A file that the table of the plan does not name is in the block of WP-124.
export const LITERAL_BASELINE: readonly string[] = [
  // @wp-begin WP-65
  'data/hooks/usePanel.ts',
  // @wp-end WP-65
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
  // @wp-begin WP-124
  'components/TokenSummary.tsx',
  'data/endpoints.ts',
  'lib/filters.ts',
  'lib/format.ts',
  'lib/panel-status.ts',
  'stream/reconcile.ts',
  // @wp-end WP-124
];
