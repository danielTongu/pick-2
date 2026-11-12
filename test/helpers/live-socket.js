/** Installs an asynchronous browser socket bridge over the real Hosted session boundary. */
export function installLiveSockets(t, gateway) {
    const network = { available: true, sockets: [], frames: [] };

    /** Browser WebSocket lifecycle with an in-memory server-side authenticated stream. */
    class LiveSocket {
        static OPEN = 1;
        static CLOSED = 3;

        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.handlers = new Map();
            this.stream = null;
            network.sockets.push(this);
            queueMicrotask(() => {
                if (this.readyState === 3) return;
                if (network.available) {
                    this.readyState = 1;
                    this.emit("open", {});
                } else {
                    this.emit("error", {});
                    this.close(1006);
                }
            });
        }

        addEventListener(name, callback) {
            this.handlers.set(name, callback);
        }

        send(raw) {
            const frame = JSON.parse(raw);
            network.frames.push(frame);
            if (frame.type === "create" || frame.type === "authenticate") {
                const send = response => {
                    if (response.type !== "event" || !network.dropEvents) {
                        queueMicrotask(() => this.emit("message", { data: JSON.stringify(response) }));
                    }
                };
                const disconnect = code => this.close(code);
                const admitted = frame.type === "create"
                    ? gateway.createStream("127.0.0.1", send, disconnect)
                    : gateway.openStream(frame.token, frame.after, send, disconnect);
                /* Admission is synchronous; browser frame delivery remains asynchronous. */
                if (admitted.stream !== null) this.stream = admitted.stream;
                else this.close(admitted.closeCode);
            } else if (frame.type === "release") {
                this.stream?.release();
            } else if (frame.type === "acknowledge") {
                this.stream.acknowledge(frame.after);
            } else {
                this.stream.receive(frame);
            }
        }

        close(code = 1000) {
            if (this.readyState !== 3) {
                this.readyState = 3;
                this.stream?.close();
                queueMicrotask(() => this.emit("close", { code }));
            }
        }

        emit(name, event) {
            this.handlers.get(name)?.(event);
        }
    }

    const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: LiveSocket });
    t.after(function restoreSocket() {
        if (original === undefined) delete globalThis.WebSocket;
        else Object.defineProperty(globalThis, "WebSocket", original);
    });
    return network;
}
