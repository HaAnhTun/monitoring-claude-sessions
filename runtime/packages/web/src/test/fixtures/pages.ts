// FIXTURE: invented data for tests
import type { EventPage, Page } from '@mcs/shared';

type PageMeta = Omit<Page<unknown>, 'items'>;

/** `Page<T>`: the items plus the paging meta; the last page by default. */
export function makePage<T>(items: T[], meta: Partial<PageMeta> = {}): Page<T> {
  return {
    items,
    nextCursor: null,
    asOfSeq: 10,
    total: null,
    totalIsLowerBound: false,
    limit: 100,
    ...meta,
  };
}

export function makeEventPage(items: EventPage['items'], meta: Partial<Omit<EventPage, 'items'>> = {}): EventPage {
  return { ...makePage(items), scanCapped: false, newerCursor: null, ...meta };
}
