import { Duplex } from "node:stream";

/** Creates connected Node duplex sockets so real HTTP/WebSocket parsers run without listening ports. */
export function memorySockets() {
    const peers = [];
    for (let index = 0; index < 2; index += 1) {
        const peerIndex = 1 - index;
        const socket = new Duplex({
            read() {},
            write(chunk, _encoding, done) {
                queueMicrotask(function deliver() {
                    if (!peers[peerIndex].destroyed) peers[peerIndex].push(Buffer.from(chunk));
                    done();
                });
            },
            final(done) {
                peers[peerIndex].push(null);
                done();
            },
            destroy(error, done) {
                if (!peers[peerIndex].destroyed) peers[peerIndex].destroy();
                done(error);
            }
        });
        socket.remoteAddress = "127.0.0.1";
        socket.setTimeout = function setTimeout() { return socket; };
        socket.setNoDelay = function setNoDelay() { return socket; };
        socket.setKeepAlive = function setKeepAlive() { return socket; };
        peers.push(socket);
    }
    return peers;
}
