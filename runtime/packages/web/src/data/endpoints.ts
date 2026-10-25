// The one place that maps the UI vocabulary to the API vocabulary (04-ui.md 3.1 rule 6, 3.2, 5.1, 5.2): endpoint names to route
// ids of the shared registry, URL state to the filter of a route. Nothing here defines an API shape; types come from @mcs/shared.
import {
  buildPath,
  type EventListQuery,
  type PanelKey,
  type RouteId,
  type SeriesQuery,
  type SessionListQuery,
  type ToolsQuery,
  type UsageQuery,
} from '@mcs/shared';

import {
  apiSortOf,
  type ActivityUrlState,
  type AnalyticsUrlState,
  type SessionsUrlState,
  type TimeRange,
} from '../lib/url-state.ts';
import { ApiError } from './api-errors.ts';

export const ENDPOINT_NAMES = [
  'instance',
  'health',
  'overview',
  'sessions',
  'session',
  'agents',
  'timeline',
  'activity',
  'transcript',
  'transcriptLocate',
  'transcriptSearch',
  'instanceSearch',
  'workItems',
  'analyticsUsage',
  'analyticsSeries',
  'analyticsTools',
  'config',
  'panel.git',
  'panel.machine',
  'panel.attempts',
  'panel.ledger',
  'panel.chainLog',
  'panel.logs',
] as const;

export type EndpointName = (typeof ENDPOINT_NAMES)[number];

/** EndpointName -> route id of the shared registry (04 5.1). */
export const ENDPOINT_ROUTE = {
  instance: 'instance',
  health: 'health',
  overview: 'overview',
  sessions: 'listSessions',
  session: 'getSession',
  agents: 'sessionAgents',
  timeline: 'sessionTimeline',
  activity: 'listEvents',
  transcript: 'transcriptWindow',
  transcriptLocate: 'transcriptLocate',
  transcriptSearch: 'searchTranscript',
  instanceSearch: 'searchTranscripts',
  workItems: 'workItemBoard',
  analyticsUsage: 'analyticsUsage',
  analyticsSeries: 'analyticsSeries',
  analyticsTools: 'analyticsTools',
  config: 'config',
  'panel.git': 'panel',
  'panel.machine': 'panel',
  'panel.attempts': 'panel',
  'panel.ledger': 'panel',
  'panel.chainLog': 'panel',
  'panel.logs': 'panel',
} as const satisfies Record<EndpointName, RouteId>;

export function panelEndpoint(key: PanelKey): EndpointName {
  return `panel.${key}`;
}

/**
 * `buildPath` for a route with path parameters. A parameter the route's schema refuses (a mistyped id in the address bar)
 * is a not-found answer without a request: it throws an `ApiError` the not-found state of 3.4 already handles.
 */
export function pathFor(
  endpoint: EndpointName,
  route: Parameters<typeof buildPath>[0],
  params: Readonly<Record<string, string | number>>,
): string {
  try {
    return buildPath(route, params);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ApiError('Not found: that identifier is not valid', {
      kind: 'http',
      status: 404,
      code: 'route_not_found',
      endpoint,
      requestId: null,
      serverMessage: 'that identifier is not valid',
    });
  }
}

// ---- filters ----------------------------------------------------------------------------------------------------------

/** The `listSessions` query as typed values (the explorer, the sidebar). `toQuery` turns it into the wire form. */
export type SessionFilter = Partial<SessionListQuery>;
/** The `listEvents` query as typed values (the activity page, the compact feed). */
export type EventFilter = Partial<EventListQuery>;

interface TimeFilter {
  range?: SessionListQuery['range'];
  from?: string;
  to?: string;
}

function timeFilter(range: TimeRange): TimeFilter {
  if (range.kind === 'preset') return { range: range.preset };
  return range.to === null ? { from: range.from } : { from: range.from, to: range.to };
}

/** The URL state of `/sessions` as the filter of the `listSessions` route; UI-only names are renamed here (3.1 rule 6). */
export function toSessionFilter(state: SessionsUrlState): SessionFilter {
  return {
    ...(state.q === '' ? {} : { q: state.q }),
    ...(state.state.length === 0 ? {} : { state: state.state }),
    ...(state.project === '' ? {} : { project: [state.project] }),
    ...(state.task === null ? {} : { workItem: state.task }),
    ...(state.model === '' ? {} : { model: [state.model] }),
    ...(state.errors ? { hasErrors: true as const } : {}),
    ...timeFilter(state.range),
    ...(state.tokMin === null ? {} : { tokensMin: state.tokMin }),
    ...(state.tokMax === null ? {} : { tokensMax: state.tokMax }),
    ...(state.unmatched ? { includeUnmatched: true as const } : {}),
    ...apiSortOf(state),
  };
}

/** The URL state of `/activity` as the filter of the `listEvents` route. */
export function toEventFilter(state: ActivityUrlState): EventFilter {
  return {
    ...(state.types.length === 0 ? {} : { category: state.types }),
    ...(state.session === '' ? {} : { session: [state.session] }),
    ...(state.project === '' ? {} : { project: [state.project] }),
    ...(state.tool === '' ? {} : { tool: [state.tool] }),
    ...(state.severity.length === 0 ? {} : { severity: state.severity }),
    ...(state.q === '' ? {} : { q: state.q }),
    ...timeFilter(state.range),
  };
}

/** `groupBy` of the usage report: the UI key `task` is the API's `workItem`. */
export function toAnalyticsUsageFilter(state: AnalyticsUrlState): Partial<UsageQuery> {
  return { groupBy: state.by === 'task' ? 'workItem' : state.by, ...timeFilter(state.range) };
}

export function toAnalyticsSeriesFilter(state: AnalyticsUrlState): Partial<SeriesQuery> {
  return { bucket: state.bucket, ...timeFilter(state.range) };
}

export function toAnalyticsToolsFilter(state: AnalyticsUrlState): Partial<ToolsQuery> {
  return { ...timeFilter(state.range) };
}
