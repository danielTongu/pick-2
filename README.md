# Pick 2

Pick 2 is a browser shedding-card game with two connection options built from the same Home and Room pages, controllers,
protocol, and rules:

- **Direct:** browser-owned rooms whose open seats are filled with bots.
- **Hosted:** shared rooms for people, configured bots, and viewers over WebSockets.

## Requirements

- Node.js 22
- npm

## Install and run

```bash
npm install --no-package-lock
npm start
```

Open [http://localhost:8080](http://localhost:8080). Use `npm run dev` for watch mode.

For static hosting, serve the repository root. `index.html` is Pick 2 Home and `room.html` is the active Room. Direct
play is always available. Set `Constants.GAME_SERVER_ORIGIN` in `core/Constants.js` to the Hosted server HTTPS URL
to try Live mode automatically. A failed connection opens retry and Local mode options. Leave it empty for Local mode. The page address is
never used as a Hosted endpoint.

In a Room with at least two Players, Start asks whether to start a **Knockout**. No plays one match; Yes starts successive matches. A Knockout match with at least three Players qualifies everyone except those tied
for the highest hand penalty for the next match. The finished order remains visible until that next match starts after a short delay, or a qualified human Player presses Start sooner. Eliminated Players leave the order at that start.
The final two play a regular match. Qualified humans remain subject to the idle timeout while waiting, and eliminated
Bots return after the Knockout ends.

The canonical public URL is `https://danieltongu.github.io/pick-2/`, and the root `sitemap.xml` contains that page.
Each Host permits up to 1,000 concurrent rooms, including the default rooms. Configure the cap with
`Host.MAX_ROOMS`. Closing a room frees a slot; joining and viewing existing rooms remain available at capacity.
This limit is a registration policy, not a measured server-capacity guarantee.

Home includes a collapsible About Pick 2 & rooms guide above the room directory. It covers connection modes, creating or joining rooms, and watching live rooms. The Room FAQ covers match setup, play, scoring, and Knockout. Both guides can be expanded without JavaScript.

## Commands

```bash
npm test
npm run test:coverage
```

## Project structure

```text
pick-2/
├── index.html              Pick 2 Home
├── room.html               Active Pick 2 Room
├── ui/Session.js           Home, Connection, and Room sessions
├── main.js                 Browser startup and dependency wiring
├── server.js              Hosted Node entry point
├── core/                   Cards, collections, players, turns, rules, hosting, bots, and mapping
├── host/                   Host coordination, connection state, and request handling
├── ui/                     Pages, cards, controllers, styles, templates, and artwork
├── test/                   Core, bots, host, UI, and architecture tests
└── docs/                   Design and maintenance documentation
```

Hosted sockets use an explicit browser-origin allowlist, connection and message limits, and heartbeat cleanup.
For another frontend domain, set `WS_ALLOWED_ORIGINS`; configure trusted proxy IPs explicitly when needed.
See [connection protection](docs/connection-protection.md) for defaults, configuration, and recipient-specific hand privacy.

The Home and Room controllers use the browser `Session` as their client API. In direct mode, the browser runs both `Session` and `Host`, with
in-process delivery handled by `Session`. Hosted setup has its own Connection page; afterward, `Session` reaches the server-side `Host` through
WebSocket and the Node server. Both return the same
`{ view, message, data }` envelope. See the [runtime architecture](docs/pick-2.md#31-runtime-architecture) for the
request flow and file map.

`CardCollection` supplies every card-storage role. Pick 2 owns its card, Room, player, turn-order, runtime, and UI
foundations directly, without single-use base layers.

See the [Pick 2 software design and maintenance reference](docs/pick-2.md) for architecture, runtime flows, domain
contracts, card interaction, testing, and operations.

## License and copyright

Copyright © Pick 2. All rights reserved.

This software is proprietary and is not free or open-source software. No permission is granted to copy, modify,
distribute, sublicense, or use it outside the terms provided by its owner.

Home and Room can be previewed without JavaScript using their HTML state attributes. See [the UI preview guide](docs/ui-preview.md) for sample data and state controls.

Test organization and focused commands are documented in the [test guide](test/README.md).
