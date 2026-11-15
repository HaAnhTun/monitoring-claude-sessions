// The WebSocket upgrade through the Express chain (CAW-25, design 02 5.2, ADR 0087). Node does not run an `upgrade` request through
// the request listener: it hands the socket to an `upgrade` listener and no response object exists. This module builds one, so
// that the handshake meets every guard of a GET (Host, Origin, fetch metadata, the URL limit, the access guard, the route's own
// checks) and every refusal is the normal JSON envelope:
//   - the listener stores the `head` bytes (what the client sent after the request), declares the request body empty (Node does
//     not read it; a POST that says `Upgrade` must not wait for bytes that belong to the new protocol), puts a `ServerResponse`
//     on the socket with `shouldKeepAlive = false` and runs the app on the pair;
//   - a refusal is written like any answer and the socket is closed as soon as it is flushed (`destroySoon`);
//   - the socket route asks `take(req)` for the head (a plain GET has none: `426 upgrade_required`), detaches the socket from the
//     response and hands it to the gateway, which answers `101` itself; the response object is then abandoned.
// A request that is not for the socket path is answered by the app as any GET (404, 405) and its socket closes. The risk of
// this design (R1: a `ServerResponse` on an upgraded socket) is proved first in `terminal-upgrade.int.test.ts`; the fallback
// would be a small raw-socket responder with the guards unchanged.
import { ServerResponse, type IncomingMessage, type RequestListener } from 'node:http';
import { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export interface UpgradeRegistry {
  /** The `head` bytes of an upgrade request, once; `undefined` for a plain GET and for a request already asked. */
  take(req: IncomingMessage): Buffer | undefined;
  /** The `upgrade` listener of the HTTP server: runs `app` on a response object that writes to the upgrade socket. */
  listener(app: RequestListener): (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

function ignoreSocketError(): void {
  // Node removed its own error handler when it gave the socket away; a reset must not become an uncaught exception
}

export function createUpgradeRegistry(): UpgradeRegistry {
  const heads = new WeakMap<IncomingMessage, Buffer>();

  return {
    take(req) {
      const head = heads.get(req);
      heads.delete(req);
      return head;
    },

    listener(app) {
      return (req, socket, head) => {
        if (!(socket instanceof Socket)) {
          // Node gives a `net.Socket` (or a TLS one); anything else is not a connection this server accepted
          socket.destroy();
          return;
        }
        heads.set(req, head);
        socket.on('error', ignoreSocketError);
        req.push(null);
        const res = new ServerResponse(req);
        res.shouldKeepAlive = false;
        res.assignSocket(socket);
        // an answer other than the hand-over: the envelope is written, then the connection ends (the gateway never reaches `finish`)
        res.once('finish', () => {
          socket.destroySoon();
        });
        try {
          app(req, res);
        } catch {
          socket.destroy();
        }
      };
    },
  };
}
