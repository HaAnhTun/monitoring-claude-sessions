// The browser side of the OS notification (ADR 0107, design attention-trust 3.7). This module is loaded with a dynamic
// `import()` (by `useAttention.ts` for a delivery, by the Settings block for the permission), so the first chunk of the page
// does not carry it. The notification holds a fixed phrase and a tag: no payload, no session name, no label, no path.
import type { OsNotification } from './attention-notifier.ts';

/** `unsupported`: this browser has no `Notification`. */
export type NotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

/** The part of a `Notification` object that is used. */
export interface NotificationLike {
  onclick: (() => void) | null;
  close(): void;
}

/** The part of the `Notification` constructor that is used. */
export interface NotificationApi {
  readonly permission: string;
  requestPermission(): Promise<string>;
  new (title: string, options: { body: string; tag: string; renotify: boolean; silent: boolean }): NotificationLike;
}

export interface NotificationEnv {
  /** `null` when the browser has none. */
  api: NotificationApi | null;
  /** Brings the window of the page to the front. */
  focus(): void;
}

function isNotificationApi(v: unknown): v is NotificationApi {
  return typeof v === 'function' && 'permission' in v && 'requestPermission' in v;
}

/** The seam of the page: the global `Notification` when it exists, and `window.focus()`. */
export function browserNotificationEnv(): NotificationEnv {
  const candidate: unknown = Reflect.get(globalThis, 'Notification');
  return {
    api: isNotificationApi(candidate) ? candidate : null,
    focus: () => {
      globalThis.focus();
    },
  };
}

function permissionOf(value: string): NotificationPermissionState {
  return value === 'granted' || value === 'denied' ? value : 'default';
}

export function notificationPermission(env: NotificationEnv = browserNotificationEnv()): NotificationPermissionState {
  return env.api === null ? 'unsupported' : permissionOf(env.api.permission);
}

/** Asks the browser; call it only from a user gesture (the button in Settings). A browser that throws answers `denied`. */
export async function requestNotificationPermission(
  env: NotificationEnv = browserNotificationEnv(),
): Promise<NotificationPermissionState> {
  if (env.api === null) return 'unsupported';
  try {
    return permissionOf(await env.api.requestPermission());
  } catch {
    return 'denied';
  }
}

/**
 * Shows one notification; the permission is read again at every delivery. Silent (no sound of the system), the same tag every
 * time so a newer one replaces the older one. A click focuses the window, runs `onClick` and closes it. False when nothing was
 * shown.
 */
export function showNotification(n: OsNotification, env: NotificationEnv = browserNotificationEnv()): boolean {
  if (env.api === null || permissionOf(env.api.permission) !== 'granted') return false;
  try {
    const shown = new env.api(n.title, { body: n.body, tag: n.tag, renotify: true, silent: true });
    shown.onclick = () => {
      env.focus();
      n.onClick();
      shown.close();
    };
    return true;
  } catch {
    // some browsers allow notifications only from a service worker: the in-page signals already said it
    return false;
  }
}
