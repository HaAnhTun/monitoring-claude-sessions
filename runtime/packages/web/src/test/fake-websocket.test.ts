import { describe, expect, it } from 'vitest';

import {
  createFakeWebSockets,
  FAKE_WS_CLOSED,
  FAKE_WS_CLOSING,
  FAKE_WS_CONNECTING,
  FAKE_WS_OPEN,
  FakeWebSocket,
  stubFakeWebSocketGlobal,
} from './fake-websocket.ts';

describe('FakeWebSocket', () => {
  it('starts connecting, opens on request and tells the handler', () => {
    const socket = new FakeWebSocket('ws://x/a', ['caw.terminal.v1']);
    let opened = 0;
    socket.onopen = () => {
      opened += 1;
    };
    expect(socket.readyState).toBe(FAKE_WS_CONNECTING);
    expect(socket.protocols).toEqual(['caw.terminal.v1']);
    socket.open();
    expect(socket.readyState).toBe(FAKE_WS_OPEN);
    expect(opened).toBe(1);
  });

  it('throws on send before the connection is open, as the real one does', () => {
    const socket = new FakeWebSocket('ws://x/a');
    expect(() => {
      socket.send('x');
    }).toThrow();
    socket.open();
    socket.send('hello');
    socket.send(Uint8Array.of(1, 2, 3));
    expect(socket.sent).toEqual([
      { kind: 'text', text: 'hello' },
      { kind: 'binary', bytes: Uint8Array.of(1, 2, 3) },
    ]);
    expect(socket.sentText).toEqual(['hello']);
    expect(socket.sentBinary).toEqual([Uint8Array.of(1, 2, 3)]);
  });

  it('drops a frame silently while the socket is closing or closed, as a browser does (only CONNECTING throws)', () => {
    const socket = new FakeWebSocket('ws://x/a');
    socket.open();
    socket.send('before');
    socket.readyState = FAKE_WS_CLOSING;
    expect(() => {
      socket.send('while closing');
      socket.send(Uint8Array.of(1));
    }).not.toThrow();
    socket.readyState = FAKE_WS_CLOSED;
    expect(() => {
      socket.send('after close');
    }).not.toThrow();
    expect(socket.sent).toEqual([{ kind: 'text', text: 'before' }]);
    const closedByClient = new FakeWebSocket('ws://x/b');
    closedByClient.open();
    closedByClient.close(1000);
    expect(() => {
      closedByClient.send('late');
    }).not.toThrow();
    expect(closedByClient.sent).toEqual([]);
  });

  it('keeps a copy of the bytes sent, so a client may reuse its buffer', () => {
    const socket = new FakeWebSocket('ws://x/a');
    socket.open();
    const bytes = Uint8Array.of(1, 2);
    socket.send(bytes);
    bytes[0] = 9;
    expect(socket.sentBinary[0]).toEqual(Uint8Array.of(1, 2));
  });

  it('delivers a binary frame as an ArrayBuffer only after binaryType was set', () => {
    const socket = new FakeWebSocket('ws://x/a');
    socket.open();
    const received: unknown[] = [];
    socket.onmessage = (event) => {
      received.push(event.data);
    };
    socket.message(Uint8Array.of(7, 8));
    socket.binaryType = 'arraybuffer';
    socket.message(Uint8Array.of(7, 8));
    socket.message('text');
    socket.message({ type: 'live' });
    expect(received[0]).toBeInstanceOf(Blob);
    expect(received[1]).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(received[1] as ArrayBuffer)]).toEqual([7, 8]);
    expect(received[2]).toBe('text');
    expect(received[3]).toBe('{"type":"live"}');
  });

  it('delivers nothing after close() unless forced', () => {
    const socket = new FakeWebSocket('ws://x/a');
    socket.open();
    let messages = 0;
    socket.onmessage = () => {
      messages += 1;
    };
    socket.close(1000, 'bye');
    expect(socket.readyState).toBe(FAKE_WS_CLOSED);
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'bye' }]);
    socket.message('late');
    expect(messages).toBe(0);
    socket.message('late', { force: true });
    expect(messages).toBe(1);
  });

  it('reports a close from the server with its code and a wasClean flag that is false for 1006', () => {
    const socket = new FakeWebSocket('ws://x/a');
    const closes: { code: number; wasClean: boolean }[] = [];
    socket.onclose = (event) => {
      closes.push({ code: event.code, wasClean: event.wasClean });
    };
    socket.closeFromServer(4000);
    socket.closeFromServer(1006);
    expect(closes).toEqual([{ code: 4000, wasClean: true }]);
    socket.closeFromServer(1006, '', { force: true });
    expect(closes.at(-1)).toEqual({ code: 1006, wasClean: false });
  });
});

describe('createFakeWebSockets', () => {
  it('records every socket its factory made', () => {
    const sockets = createFakeWebSockets();
    expect(() => sockets.last()).toThrow();
    const first = sockets.factory('ws://x/1', ['a']);
    const second = sockets.factory('ws://x/2', []);
    expect(sockets.instances).toEqual([first, second]);
    expect(sockets.last()).toBe(second);
    expect(sockets.urls()).toEqual(['ws://x/1', 'ws://x/2']);
  });
});

describe('stubFakeWebSocketGlobal', () => {
  it('lets code that constructs the global WebSocket get a fake and records it', () => {
    const sockets = stubFakeWebSocketGlobal();
    const made = new globalThis.WebSocket('ws://x/g', ['caw.terminal.v1']);
    expect(sockets.last()).toBe(made);
    expect(sockets.last().protocols).toEqual(['caw.terminal.v1']);
  });
});
