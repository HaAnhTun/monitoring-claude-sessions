// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  browserNotificationEnv,
  notificationPermission,
  requestNotificationPermission,
  showNotification,
  type NotificationApi,
  type NotificationEnv,
  type NotificationLike,
} from './attention-env.ts';

interface Shown {
  title: string;
  options: unknown;
  instance: NotificationLike;
  closed: boolean;
}

function fakeEnv(permission: string, answer: string | Error = 'granted') {
  const shown: Shown[] = [];
  let focused = 0;
  class FakeNotification implements NotificationLike {
    static permission = permission;
    static requestPermission(): Promise<string> {
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }
    onclick: NotificationLike['onclick'] = null;
    readonly record: Shown;
    constructor(title: string, options: unknown) {
      this.record = { title, options, instance: this, closed: false };
      shown.push(this.record);
    }
    close(): void {
      this.record.closed = true;
    }
  }
  const api: NotificationApi = FakeNotification;
  const env: NotificationEnv = {
    api,
    focus: () => {
      focused += 1;
    },
  };
  return { env, shown, focusCount: () => focused };
}

const NOTE = { title: 'FIXTURE app', body: 'FIXTURE body', tag: 'caw-attention' };

describe('the OS notification seam', () => {
  it.each([
    ['granted', 'granted'],
    ['denied', 'denied'],
    ['default', 'default'],
    ['something new', 'default'],
  ])('reads the permission %s as %s', (permission, expected) => {
    expect(notificationPermission(fakeEnv(permission).env)).toBe(expected);
  });

  it('a browser without notifications is unsupported and shows nothing', async () => {
    const none: NotificationEnv = { api: null, focus: () => undefined };
    expect(notificationPermission(none)).toBe('unsupported');
    expect(await requestNotificationPermission(none)).toBe('unsupported');
    expect(showNotification({ ...NOTE, onClick: () => undefined }, none)).toBe(false);
    // Node has no Notification: the seam of the page says so instead of throwing
    expect(browserNotificationEnv().api).toBeNull();
  });

  it('asks the browser and answers denied when the request throws', async () => {
    expect(await requestNotificationPermission(fakeEnv('default', 'granted').env)).toBe('granted');
    expect(await requestNotificationPermission(fakeEnv('default', 'denied').env)).toBe('denied');
    expect(await requestNotificationPermission(fakeEnv('default', new Error('FIXTURE')).env)).toBe('denied');
  });

  it('shows a silent notification with the fixed tag, and a click focuses the window, opens the row and closes it', () => {
    const { env, shown, focusCount } = fakeEnv('granted');
    let clicks = 0;
    const done = showNotification(
      {
        ...NOTE,
        onClick: () => {
          clicks += 1;
        },
      },
      env,
    );
    expect(done).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      title: 'FIXTURE app',
      options: { body: 'FIXTURE body', tag: 'caw-attention', renotify: true, silent: true },
    });
    shown[0]?.instance.onclick?.();
    expect([clicks, focusCount(), shown[0]?.closed]).toEqual([1, 1, true]);
  });

  it('reads the permission again at every delivery', () => {
    for (const permission of ['default', 'denied']) {
      const { env, shown } = fakeEnv(permission);
      expect(showNotification({ ...NOTE, onClick: () => undefined }, env)).toBe(false);
      expect(shown).toEqual([]);
    }
  });
});
