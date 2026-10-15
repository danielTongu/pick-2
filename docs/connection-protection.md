# Hosted connection protection

`server/WebSocketGateway.js` owns browser-origin checks, socket resource limits, ping/pong cleanup, and adaptation to Host connections. Host remains transport-neutral. These limits bound resources; they are not a measured nationwide capacity guarantee or a replacement for deployment-level protection.

## Hand privacy

Room snapshots are recipient-specific in both Direct and Hosted modes:

- During waiting and active play, a seated player receives only their own hand and penalty.
- Other hands contain `items: []`, their public `itemCount`, and `penalty: null`.
- Viewers receive counts only. The undealt deck remains count-only for everyone.
- Finished matches reveal hands and penalties for the existing results view. Starting or resuming another match hides other hands again.

Bots retain server-side access to the authoritative Room for their existing strategy. Hiding transport fields does not change that strategy.

## Allowed origins and proxy trust

`WS_ALLOWED_ORIGINS` is an exact, comma-separated allowlist of HTTP/HTTPS browser origins. It replaces the default list. Missing, opaque (`null`), and unlisted origins are rejected before upgrade with HTTP 403.

Defaults allow the existing `https://danieltongu.github.io` frontend plus HTTP localhost, loopback, and the server's current IPv4 LAN addresses at its listening port. Configure the frontend's actual origin when using another domain or HTTPS frontend:

```sh
WS_ALLOWED_ORIGINS=https://game.example.com PORT=8080 npm start
```

An origin has a scheme, hostname and optional port; it is not a page URL or wildcard. Origin checks protect the browser boundary; clients outside a browser can supply an Origin header and must still obey all resource and game-command checks.

By default, IP limits use the socket peer and ignore forwarded headers. Set `WS_TRUSTED_PROXY_IPS` only to the exact addresses of proxies you control. The gateway walks `X-Forwarded-For` from the trusted peer toward the nearest untrusted address and normalizes IPv4-mapped IPv6. Arbitrary clients cannot change their limit bucket by sending a forged header. Without proxy configuration, a reverse proxy's clients share its IP bucket. CIDR ranges and hostname-based proxy trust are not enabled.

## Resource limits

| Setting | Default | Behavior |
| --- | --- | --- |
| `WS_MAX_CONNECTIONS` | 5,000 | Reject further upgrades with HTTP 503 until a socket closes |
| `WS_MAX_CONNECTIONS_PER_IP` | 128 | Reject further upgrades from that client IP with HTTP 429 |
| `WS_MAX_UPGRADES_PER_IP` | 120 per 60 seconds | Bound repeated handshakes, including fresh sockets |
| `WS_MAX_PAYLOAD_BYTES` | 8,192 | Close oversized messages with WebSocket code 1009 |
| `WS_MAX_BUFFERED_BYTES` | 262,144 | Terminate a socket before outgoing queued data exceeds its budget |
| `WS_MAX_MESSAGES_PER_WINDOW` | 60 per 10 seconds | Close a flooding client with code 1008 before dispatching more Host work |

Configuration values must be positive integers; invalid values fail startup. The class also bounds unfinished Host requests to eight per socket and retained handshake IP counters to 10,000. The maintenance loop expires old counters.

Only text JSON frames are accepted: binary frames close with code 1003, malformed JSON with 1007. Compression is disabled. HTTP header/request deadlines bound incomplete requests. Closing or rejecting a socket releases its capacity and Host membership.

Maintenance runs every 30 seconds. Clients are pinged, pong replies mark them responsive, and clients missing the next heartbeat are forcibly removed. Policy closes have a one-second grace period before termination. Shutdown closes sockets and waits for Host membership cleanup.

## Verification

`npm run test:server` uses real temporary localhost HTTP/WebSocket servers. It covers origins, global and per-IP capacity, forwarded-header spoofing, trusted proxies, handshake rate, payloads, malformed frames, message/work limits, outbound budgets, heartbeat cleanup, environment configuration, graceful shutdown, and a real Host hand-privacy flow.

The tests require permission to listen on localhost. The full `npm test` run includes them; they are not silently skipped in restricted environments.
