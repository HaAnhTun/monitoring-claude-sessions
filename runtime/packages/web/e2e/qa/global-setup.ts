// Configuration and global setup of the visual QA tool (WP-122). The tool is steered by environment variables (registered in
// `shared/src/env.ts`): where the pictures go (`MCS_SHOTS_DIR`, never inside the repository), which views, viewports, themes and
// languages to shoot, and whether to force live or fixture mode. Reading and validating them is one function, so that the spec,
// the self-test and the global setup agree. The global setup only checks the output folder before anything is started.
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
export const LOCALES = ['en', 'vi'] as const;
export type Locale = (typeof LOCALES)[number];

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** The three window sizes of the review (1440, 1024 and 600 px wide). Headless Chrome has no window below 500 px. */
export const DEFAULT_VIEWPORTS: readonly Viewport[] = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 600, height: 900 },
];
export const MIN_VIEWPORT_WIDTH = 500;

/**
 * The two extra window sizes of the views marked `wide` (the workspace, the terminal and the style guide; design 05 section 7.1):
 * a large desktop window and a small laptop one.
 */
export const WIDE_VIEWPORTS: readonly Viewport[] = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
];

/** The one forced-colours column of the matrix: this window size and theme, for the views marked `forcedColors`. */
export const FORCED_COLORS_VIEWPORT: Viewport = { width: 1440, height: 900 };
export const FORCED_COLORS_THEME: Theme = 'light';

export interface ShotsConfig {
  /** Absolute, outside the repository, real path of the nearest existing folder resolved. */
  readonly dir: string;
  /** `all` or the ids named. */
  readonly views: 'all' | readonly string[];
  readonly viewports: readonly Viewport[];
  /**
   * The extra sizes of the views marked `wide`: `WIDE_VIEWPORTS`, or none when `MCS_SHOTS_VIEWPORTS` names the sizes (that list is
   * then the whole matrix of every view).
   */
  readonly wideViewports: readonly Viewport[];
  readonly themes: readonly Theme[];
  readonly locales: readonly Locale[];
  /** `live` or `fixture` forces the mode of every view that can run in it; `null` keeps the mode of each view. */
  readonly mode: 'live' | 'fixture' | null;
}

/** The folder above `path` (or `path` itself) that holds `.git`: the repository a path would belong to. */
export function repositoryRootOf(path: string): string | null {
  let current = resolve(path);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The real path of `path` even when it does not exist yet: the nearest existing ancestor is resolved (links, short names) and the rest appended. */
export function realPathOf(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync.native(current), ...rest);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The output folder: required, made absolute against the working folder, and refused when it lies inside the repository the tool
 * belongs to (a relative path, a path through a link or a junction, a short Windows name and a different letter case included).
 */
export function resolveShotsDir(value: string | undefined, repoRoot: string | null = defaultRepositoryRoot()): string {
  if (value === undefined || value.trim() === '') {
    throw new Error('MCS_SHOTS_DIR is required: the folder for the pictures and index.json, outside the repository');
  }
  const real = realPathOf(value);
  if (repoRoot !== null && isInside(realPathOf(repoRoot), real)) {
    throw new Error(`MCS_SHOTS_DIR must be outside the repository, but ${real} is inside ${repoRoot}`);
  }
  return real;
}

function defaultRepositoryRoot(): string | null {
  return repositoryRootOf(dirname(fileURLToPath(import.meta.url)));
}

function listOf(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function parseViewports(value: string | undefined): readonly Viewport[] {
  const parts = listOf(value);
  if (parts.length === 0) return DEFAULT_VIEWPORTS;
  return parts.map((part) => {
    const m = /^([0-9]{3,5})x([0-9]{3,5})$/.exec(part);
    if (m === null) throw new Error(`MCS_SHOTS_VIEWPORTS: '${part}' is not WIDTHxHEIGHT (for example 1440x900)`);
    const width = Number(m[1]);
    const height = Number(m[2]);
    if (width < MIN_VIEWPORT_WIDTH) {
      throw new Error(
        `MCS_SHOTS_VIEWPORTS: headless Chrome has no window below ${String(MIN_VIEWPORT_WIDTH)} px, got ${part}`,
      );
    }
    return { width, height };
  });
}

function parseChoice<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): readonly T[] {
  const parts = listOf(value);
  if (parts.length === 0) return allowed;
  return parts.map((part) => {
    const found = allowed.find((candidate) => candidate === part);
    if (found === undefined) throw new Error(`${name}: '${part}' is none of ${allowed.join(', ')}`);
    return found;
  });
}

/** Reads and validates the environment of the tool. */
export function readShotsConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  repoRoot: string | null = defaultRepositoryRoot(),
): ShotsConfig {
  const views = listOf(env['MCS_SHOTS_VIEWS']);
  const mode = env['MCS_SHOTS_MODE'];
  if (mode !== undefined && mode !== '' && mode !== 'live' && mode !== 'fixture') {
    throw new Error(`MCS_SHOTS_MODE: '${mode}' is neither live nor fixture`);
  }
  return {
    dir: resolveShotsDir(env['MCS_SHOTS_DIR'], repoRoot),
    views: views.length === 0 || views.includes('all') ? 'all' : views,
    viewports: parseViewports(env['MCS_SHOTS_VIEWPORTS']),
    wideViewports: listOf(env['MCS_SHOTS_VIEWPORTS']).length === 0 ? WIDE_VIEWPORTS : [],
    themes: parseChoice('MCS_SHOTS_THEMES', env['MCS_SHOTS_THEMES'], THEMES),
    locales: parseChoice('MCS_SHOTS_LOCALES', env['MCS_SHOTS_LOCALES'], LOCALES),
    mode: mode === 'live' || mode === 'fixture' ? mode : null,
  };
}

// ---- the matrix: which view is shot in which column (CAW-49) ----------------------------------------------------------------------

/** What the matrix reads of a view (`ViewSpec` of `views.ts` has both). */
export interface MatrixView {
  /** Also shot at `WIDE_VIEWPORTS`. */
  readonly wide?: boolean;
  /** Also shot in the forced-colours column. */
  readonly forcedColors?: boolean;
}

/** One column of the matrix: one browser context, and one test of `shots.spec.ts`. */
export interface ShotColumn {
  readonly viewport: Viewport;
  readonly theme: Theme;
  readonly locale: Locale;
  /** The browser emulates `forced-colors: active` (the high-contrast mode of the system). */
  readonly forcedColors: boolean;
}

type MatrixConfig = Pick<ShotsConfig, 'viewports' | 'wideViewports' | 'themes' | 'locales'>;

const sameViewport = (a: Viewport, b: Viewport): boolean => a.width === b.width && a.height === b.height;

/** The window sizes a view is shot at: the selected ones, and the wide ones after them for a view marked `wide`. */
export function viewportsOf(view: MatrixView, config: Pick<ShotsConfig, 'viewports' | 'wideViewports'>): Viewport[] {
  const extra = view.wide === true ? config.wideViewports : [];
  return [
    ...config.viewports,
    ...extra.filter((wide) => !config.viewports.some((viewport) => sameViewport(viewport, wide))),
  ];
}

/** The forced-colours column runs when the selection still holds its window size and its theme. */
function forcedColorsColumn(config: MatrixConfig): ShotColumn | null {
  const locale = config.locales[0];
  if (locale === undefined || !config.themes.includes(FORCED_COLORS_THEME)) return null;
  if (!config.viewports.some((viewport) => sameViewport(viewport, FORCED_COLORS_VIEWPORT))) return null;
  return { viewport: FORCED_COLORS_VIEWPORT, theme: FORCED_COLORS_THEME, locale, forcedColors: true };
}

/**
 * Every column in which at least one of `views` is shot, in a fixed order: the selected window sizes, then the wide ones (when a
 * view is marked `wide`), each in every theme and language, and the forced-colours column last (when a view is marked for it).
 */
export function columnsOf(views: readonly MatrixView[], config: MatrixConfig): ShotColumn[] {
  const viewports = viewportsOf({ wide: views.some((view) => view.wide === true) }, config);
  const columns: ShotColumn[] = viewports.flatMap((viewport) =>
    config.themes.flatMap((theme) =>
      config.locales.map((locale): ShotColumn => ({ viewport, theme, locale, forcedColors: false })),
    ),
  );
  const forced = views.some((view) => view.forcedColors === true) ? forcedColorsColumn(config) : null;
  return forced === null ? columns : [...columns, forced];
}

/** Whether a view is shot in a column. */
export function inColumn(
  view: MatrixView,
  column: ShotColumn,
  config: Pick<ShotsConfig, 'viewports' | 'wideViewports'>,
): boolean {
  if (column.forcedColors) return view.forcedColors === true;
  return viewportsOf(view, config).some((viewport) => sameViewport(viewport, column.viewport));
}

/** `1440x900 light en`, with `forced-colors` after it for that column: the title of the test and the key of a column. */
export function columnTitle(column: ShotColumn): string {
  const { width, height } = column.viewport;
  const base = `${String(width)}x${String(height)} ${column.theme} ${column.locale}`;
  return column.forcedColors ? `${base} forced-colors` : base;
}

/** The file of one picture: `<view>__<width>x<height>__<theme>__<language>.png`; the forced-colours column says so after the theme. */
export function shotFileName(viewId: string, column: ShotColumn): string {
  const { width, height } = column.viewport;
  const theme = column.forcedColors ? `${column.theme}-forced` : column.theme;
  return `${viewId}__${String(width)}x${String(height)}__${theme}__${column.locale}.png`;
}

/** Runs once before the tests: the output folder is checked and created before any instance is started. */
export default function globalSetup(): void {
  const config = readShotsConfig();
  mkdirSync(config.dir, { recursive: true });
}
