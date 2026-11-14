// The style guide of the visual QA tool (CAW-35, design 05 sections 7.2 and 7.3): one static page of every primitive of the
// interface and its states, injected into the loaded app so that the real stylesheets draw it. It is shot as the views `styleguide`
// and `styleguide-focus`, and the text measurements (contrast, monospace, tiny and clipped text) judge it like any other page.
//
// Rules of this file:
//   - Every word on the page comes from the catalogues of the language (`en.ts`, `vi.ts`); a heading is the name of the CSS
//     primitive (an identifier, the same in both languages). Only a few fixed technical tokens (an id, a time, an age) are literal.
//   - No `style` attribute and no script: the server sends `style-src 'self'`, and the page is data. The one thing a reserved
//     height needs (an open popover is positioned absolutely) is set through the CSSOM by `injectStyleguide`, which CSP allows.
//   - The Vietnamese stress line is built from base letters and combining marks and normalised to NFC, so this file holds no
//     Vietnamese letter (the English guard allows them in the catalogue only).
import type { Page } from '@playwright/test';

import { formatMessage } from '../../src/i18n/format-message.ts';
import { enMessages } from '../../src/i18n/messages/en.ts';
import { viMessages } from '../../src/i18n/messages/vi.ts';
import type { Locale, MessageKey } from '../../src/i18n/types.ts';
import { lifecycleDisplay } from '../../src/lib/lifecycle-display.ts';

/** The Tab presses after the start of the guide that put the focus on the control the focus view shows (`data-qa-focus-target`). */
export const STYLEGUIDE_FOCUS_STOPS = 3;

/** The element the focus view starts from: it takes the focus, the first Tab leaves it for the first control of the guide. */
export const STYLEGUIDE_START = '[data-qa="styleguide-start"]';

// ---- the Vietnamese stress line --------------------------------------------------------------------------------------------------

const COMBINING = {
  circumflex: 0x302,
  breve: 0x306,
  horn: 0x31b,
} as const;

/** The tone marks: none, acute, grave, hook above, tilde, dot below (the last one stacks under a circumflex or a breve). */
const TONES: readonly number[] = [0, 0x301, 0x300, 0x309, 0x303, 0x323];

/** The twelve vowel letters of the alphabet as a base letter plus its own mark (none, circumflex, breve or horn). */
const VOWELS: readonly (readonly [string, number | null])[] = [
  ['a', null],
  ['a', COMBINING.breve],
  ['a', COMBINING.circumflex],
  ['e', null],
  ['e', COMBINING.circumflex],
  ['i', null],
  ['o', null],
  ['o', COMBINING.circumflex],
  ['o', COMBINING.horn],
  ['u', null],
  ['u', COMBINING.horn],
  ['y', null],
];

/**
 * Text with every stacked mark of the language: each vowel letter with each tone, in lower and upper case, then the stroked d.
 * Built from base letters and combining marks and normalised to NFC; a capital with two marks (the tallest case) is in it, which
 * is what a clipped line shows first.
 */
export function vietnameseStressLine(): string {
  const words: string[] = [];
  for (const [base, own] of VOWELS) {
    let word = '';
    for (const tone of TONES) {
      const marks = (own === null ? '' : String.fromCharCode(own)) + (tone === 0 ? '' : String.fromCharCode(tone));
      word += (base + marks).normalize('NFC');
    }
    words.push(word);
  }
  const lower = words.join(' ');
  const stroked = String.fromCharCode(0x111);
  return `${lower} ${stroked} ${lower.toUpperCase()} ${stroked.toUpperCase()}`.normalize('NFC');
}

// ---- markup helpers --------------------------------------------------------------------------------------------------------------

const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

type Say = (key: MessageKey, args?: Readonly<Record<string, unknown>>) => string;

function sayIn(locale: Locale): Say {
  const catalogue: Readonly<Record<string, string>> = locale === 'vi' ? viMessages : enMessages;
  return (key, args) => {
    const message = catalogue[key];
    if (message === undefined) throw new Error(`the catalogue has no ${key}`);
    return escapeHtml(formatMessage(message, args, locale));
  };
}

/** A decorative 16 px icon: a plain circle with a check, drawn with presentation attributes only (no style attribute). */
const ICON =
  '<svg class="icon" aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>';

const section = (name: string, body: string): string =>
  `<section class="qa-section" data-qa-section="${name}"><h2 class="mono">${name}</h2>${body}</section>`;

// ---- the sections ----------------------------------------------------------------------------------------------------------------

function buttons(say: Say): string {
  const cell = (inner: string): string => `<span class="qa-cell">${inner}</span>`;
  return section(
    '.btn',
    `<div class="btn-group">` +
      cell(`<button type="button" class="btn btn-primary">${say('common.retryNow')}</button>`) +
      cell(`<button type="button" class="btn">${say('common.retry')}</button>`) +
      cell(`<button type="button" class="btn btn-quiet" data-qa-focus-target>${say('common.copy')}</button>`) +
      cell(`<button type="button" class="btn btn-icon" aria-label="${say('common.close')}">${ICON}</button>`) +
      `</div>` +
      `<div class="btn-group">` +
      cell(`<button type="button" class="btn btn-primary" disabled>${say('common.retryNow')}</button>`) +
      cell(`<button type="button" class="btn" disabled>${say('common.retry')}</button>`) +
      cell(`<button type="button" class="btn btn-quiet" disabled>${say('common.copy')}</button>`) +
      cell(`<button type="button" class="btn btn-icon" disabled aria-label="${say('common.close')}">${ICON}</button>`) +
      `</div>` +
      `<div class="btn-group">` +
      cell(`<button type="button" class="btn" aria-pressed="true">${say('menu.theme.dark')}</button>`) +
      cell(`<button type="button" class="btn" aria-pressed="false">${say('menu.theme.light')}</button>`) +
      cell(`<button type="button" class="btn is-loading" aria-busy="true" disabled>${say('common.loading')}</button>`) +
      `</div>`,
  );
}

function fields(say: Say): string {
  return section(
    '.input',
    `<div class="qa-cell"><label class="small muted" for="qa-input-empty">${say('sessions.filter.search')}</label>` +
      `<input id="qa-input-empty" class="input" type="text" placeholder="${say('sessions.filter.searchPlaceholder')}"></div>` +
      `<div class="qa-cell"><label class="small muted" for="qa-input-value">${say('sessions.filter.model')}</label>` +
      `<input id="qa-input-value" class="input" type="text" value="${say('state.working.label')}"></div>` +
      `<div class="qa-cell"><label class="small muted" for="qa-input-off">${say('sessions.filter.project')}</label>` +
      `<input id="qa-input-off" class="input" type="text" value="${say('common.notAvailable')}" disabled></div>`,
  );
}

function chips(say: Say): string {
  return section(
    '.chip',
    `<span class="chip">${say('state.group.active')}</span>` +
      `<span class="chip chip--filter"><span class="filter-bar__chip-text">${say('sessions.filter.errors')}</span>` +
      `<button type="button" class="chip__remove" aria-label="${say('common.close')}">${ICON}</button></span>`,
  );
}

function cards(say: Say): string {
  return section(
    '.card',
    `<div class="card"><h3>${say('menu.theme')}</h3><p class="muted">${say('state.running.description')}</p>` +
      `<p class="small"><span class="mono">9a9a9a9a</span> ${say('common.notAvailable')}</p></div>` +
      `<div class="card card--flush"><p>${say('state.waiting_tool.description')}</p></div>`,
  );
}

function popovers(say: Say): string {
  return section(
    '.popover .menu',
    `<div class="qa-stage" data-qa-reserve=".popover__panel">` +
      `<div class="popover"><button type="button" class="btn" aria-haspopup="dialog" aria-expanded="true" aria-controls="qa-popover-panel">${say('menu.language')}</button>` +
      `<div id="qa-popover-panel" role="dialog" class="popover__panel" aria-label="${say('menu.language')}">` +
      `<p>${say('state.stale.description')}</p></div></div></div>` +
      `<div class="qa-stage" data-qa-reserve=".menu__panel">` +
      `<div class="menu"><button type="button" class="btn btn-icon" aria-label="${say('menu.trigger')}" aria-haspopup="menu" aria-expanded="true" aria-controls="qa-menu-panel">${ICON}</button>` +
      `<div id="qa-menu-panel" role="menu" class="menu__panel" aria-label="${say('menu.trigger')}" tabindex="-1">` +
      `<div role="group" class="menu__group" aria-labelledby="qa-menu-heading"><div id="qa-menu-heading" class="menu__heading">${say('menu.theme')}</div>` +
      `<button type="button" role="menuitemradio" aria-checked="true" class="menu__item" tabindex="-1"><span class="menu__text">${say('menu.theme.dark')}</span>${ICON}</button>` +
      `<button type="button" role="menuitemradio" aria-checked="false" class="menu__item" tabindex="-1"><span class="menu__text">${say('menu.theme.light')}</span></button></div>` +
      `<div role="separator" class="menu__separator"></div>` +
      `<button type="button" role="menuitem" class="menu__item" tabindex="-1"><span class="menu__text">${say('menu.shortcuts')}</span></button>` +
      `</div></div></div>`,
  );
}

function dialog(say: Say): string {
  return section(
    '.dialog',
    `<div class="dialog" role="dialog" aria-labelledby="qa-dialog-title">` +
      `<h3 id="qa-dialog-title">${say('shortcuts.title')}</h3>` +
      `<p>${say('shortcuts.group.navigation')}: <kbd class="kbd">${say('shortcuts.key.up')}</kbd> <kbd class="kbd">${say('shortcuts.key.down')}</kbd></p>` +
      `<div class="btn-group"><button type="button" class="btn btn-primary">${say('common.close')}</button>` +
      `<button type="button" class="btn btn-quiet">${say('common.copy')}</button></div></div>`,
  );
}

/** The seven tones of the states, each as a state of its own: the badge observed and inferred. */
const BADGE_STATES = ['working', 'waiting_input', 'turn_ended', 'completed', 'failed', 'stale', 'unknown'] as const;

function badge(say: Say, state: string, inferred: boolean): string {
  const display = lifecycleDisplay(state);
  const classes = ['badge', 'badge--state', display.toneClass];
  if (inferred) classes.push('badge--inferred');
  const label = say(display.labelKey);
  const word = inferred && display.group === 'active' ? say('badge.inferredLabel', { label }) : label;
  return (
    `<span class="${classes.join(' ')}" data-state="${display.state}"${inferred ? ' data-basis="inferred"' : ''}>` +
    `<span class="state-dot state-dot--${display.dot}" aria-hidden="true"></span><span class="badge__word">${word}</span></span>`
  );
}

function badges(say: Say): string {
  const observed = BADGE_STATES.map((state) => `<span class="qa-cell">${badge(say, state, false)}</span>`).join('');
  const inferred = BADGE_STATES.map((state) => `<span class="qa-cell">${badge(say, state, true)}</span>`).join('');
  const tags = (['running', 'waiting', 'idle', 'completed', 'failed', 'unknown', 'stale', 'partial', 'ok'] as const)
    .map(
      (tone) =>
        `<span class="qa-cell"><span class="badge badge--tag tone-${tone}">${ICON}<span>${say('state.group.active')}</span></span></span>`,
    )
    .join('');
  return section(
    '.badge',
    `<div class="session-tags">${observed}</div><div class="session-tags">${inferred}</div><div class="session-tags">${tags}</div>` +
      `<p class="small"><span class="evidence-line" data-evidence="inferred" title="${say('evidence.basisTip', { basis: say('evidence.basis.inferred'), confidence: say('evidence.confidence.medium') })}">` +
      `${say('evidence.inferredQuiet', { age: '18m' })}</span></p>`,
  );
}

function table(say: Say): string {
  const row = (id: string, state: string, current: boolean): string =>
    `<tr class="data-table__row"${current ? ' aria-current="true"' : ''}>` +
    `<td>${badge(say, state, false)}</td>` +
    `<td><span class="session-cell"><span class="session-cell__label">${say(lifecycleDisplay(state).descriptionKey)}</span> <span class="session-cell__id mono">${id}</span></span></td>` +
    `<td>${say('time.earlier')}</td></tr>`;
  return section(
    '.data-table',
    `<div class="tbl-wrap"><table class="data-table"><caption class="sr-only">${say('sessions.table.caption')}</caption>` +
      `<thead><tr><th scope="col">${say('sessions.col.state')}</th><th scope="col">${say('sessions.col.session')}</th><th scope="col">${say('sessions.col.lastActivity')}</th></tr></thead>` +
      `<tbody>${row('9a9a9a01', 'working', false)}${row('9a9a9a02', 'waiting_input', true)}${row('9a9a9a03', 'failed', false)}</tbody></table></div>`,
  );
}

function transcript(say: Say): string {
  const body = say('state.running.description');
  const item = (kind: string, label: MessageKey, extra = ''): string =>
    `<li class="tr tr--${kind}${extra}"><div class="tr-head"><span class="tr-kind">${ICON}<span>${say(label)}</span></span>` +
    `<span class="tr-index muted small">#1</span></div><div class="tr-body"><p>${body}</p></div></li>`;
  return section(
    '.tr',
    `<ul class="tv-list">` +
      item('prompt', 'transcript.kind.prompt') +
      item('say', 'transcript.kind.say') +
      item('think', 'transcript.kind.think') +
      item('tool', 'transcript.kind.tool') +
      item('result', 'transcript.kind.result') +
      item('result', 'transcript.kind.result', ' tr--error') +
      `</ul>`,
  );
}

function stateCards(say: Say): string {
  return section(
    '.state',
    `<div class="state state--empty" role="status"><div class="state__title">${ICON}<span>${say('sessions.empty.title')}</span></div>` +
      `<div class="state__body"><p>${say('sessions.empty.cause.folder')}</p></div>` +
      `<div class="state__actions"><button type="button" class="btn btn-primary">${say('sessions.empty.showUnmatched')}</button></div></div>` +
      `<div class="state state--error" role="alert"><div class="state__title">${ICON}<span>${say('error.load', { subject: say('error.subject.sessions') })}</span></div>` +
      `<div class="state__actions"><button type="button" class="btn">${say('common.retryNow')}</button></div></div>` +
      `<div class="card" data-stale-scope data-stale="true"><p class="stale-indicator tone-stale">${ICON}<span>${say('freshness.asOf', { scope: say('error.subject.sessions'), time: '12:00:00', age: '45s', reason: say('freshness.reason.refreshFailing') })}</span></p>` +
      `<p>${say('state.stale.description')}</p></div>`,
  );
}

function feedback(say: Say): string {
  return section(
    '.toast .kbd',
    `<div class="toast" role="status"><span>${say('common.copied')}</span></div>` +
      `<div class="toast toast--error" role="alert"><span>${say('common.copyFailed')}</span>` +
      `<button type="button" class="btn btn-icon" aria-label="${say('toast.dismiss')}">${ICON}</button></div>` +
      `<p><kbd class="kbd">${say('shortcuts.key.esc')}</kbd> <kbd class="kbd">${say('shortcuts.key.home')}</kbd> ` +
      `<kbd class="kbd">${say('shortcuts.key.end')}</kbd></p>`,
  );
}

function stress(): string {
  const line = vietnameseStressLine();
  return section(
    'vi',
    `<p lang="vi" class="mono" data-qa="vi-stress">${line}</p>` +
      `<div class="session-tags"><button type="button" class="btn">${line.slice(0, 40)}</button>` +
      `<span class="badge badge--tag tone-idle"><span>${line.slice(0, 40)}</span></span></div>` +
      `<div class="data-card"><div class="data-card__head"><span class="data-card__title">${line.slice(0, 60)}</span></div></div>`,
  );
}

/** The whole guide as HTML for the language: the title, the focus start and every section. */
export function buildStyleguideHtml(locale: Locale): string {
  const say = sayIn(locale);
  return (
    `<div class="page qa-styleguide" data-qa="styleguide" lang="${locale}">` +
    `<h1 tabindex="-1" class="mono" data-qa="styleguide-start">styleguide</h1>` +
    [
      buttons(say),
      fields(say),
      chips(say),
      cards(say),
      badges(say),
      table(say),
      transcript(say),
      stateCards(say),
      popovers(say),
      dialog(say),
      feedback(say),
      stress(),
    ].join('') +
    `</div>`
  );
}

// ---- injecting the guide into the loaded app --------------------------------------------------------------------------------------

/**
 * Replaces the content of the page's `main` element with the guide for the language and makes the page as tall as the guide, so
 * that one picture shows all of it. The app's own stylesheets draw it. An open popover or menu is positioned absolutely, so its
 * box gets the room of its panel through the CSSOM (allowed by `style-src 'self'`, unlike an attribute in the markup).
 */
export async function injectStyleguide(page: Page, locale: Locale): Promise<void> {
  const html = buildStyleguideHtml(locale);
  await page.evaluate(
    `((html) => {
      const main = document.querySelector('main');
      if (!main) throw new Error('the page has no main element to hold the style guide');
      main.innerHTML = html;
      for (const stage of main.querySelectorAll('[data-qa-reserve]')) {
        const panel = stage.querySelector(stage.getAttribute('data-qa-reserve'));
        if (panel) stage.style.minHeight = String(Math.ceil(panel.getBoundingClientRect().height) + 56) + 'px';
      }
    })(${JSON.stringify(html)})`,
  );
  await page.evaluate(
    'document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))',
  );
  const height = Number(await page.evaluate('Math.ceil(document.documentElement.scrollHeight)'));
  const size = page.viewportSize();
  if (size !== null && Number.isFinite(height) && height > size.height) {
    await page.setViewportSize({ width: size.width, height: Math.min(height, 12_000) });
  }
}

/** Puts the focus on the start of the guide and presses Tab until the focus target has it; fails when it is somewhere else. */
export async function focusStyleguideTarget(page: Page): Promise<void> {
  await page.locator(STYLEGUIDE_START).focus();
  for (let press = 0; press < STYLEGUIDE_FOCUS_STOPS; press += 1) await page.keyboard.press('Tab');
  const onTarget: unknown = await page.evaluate(
    "document.activeElement !== null && document.activeElement.hasAttribute('data-qa-focus-target')",
  );
  if (onTarget !== true)
    throw new Error(`the focus is not on the focus target after ${String(STYLEGUIDE_FOCUS_STOPS)} Tab presses`);
}
