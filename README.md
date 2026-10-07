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
play is always available; Home enables Hosted mode when its configured WebSocket host is reachable.

In a Room with at least two Actors, Start asks whether to start a **Knockout**. No plays one match; Yes starts successive matches. A Knockout match with at least three Actors qualifies everyone except those tied
for the highest hand penalty for the next match. The finished order remains visible until that next match starts after a short delay, or a qualified human Actor presses Start sooner. Eliminated Actors leave the order at that start.
The final two play a regular match. Qualified humans remain subject to the idle timeout while waiting, and eliminated
Bots return after the Knockout ends.

The canonical public URL is `https://danieltongu.github.io/pick-2/`, and the root `sitemap.xml` contains that page.
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
├── core/                   Cards, collections, actors, turns, rules, hosting, bots, and mapping
├── host/                   Host coordination, connection state, and request handling
├── ui/                     Pages, cards, controllers, styles, templates, and artwork
├── test/                   Pick 2, infrastructure, and navigation tests
└── docs/                   Design and maintenance documentation
```

The Home and Room controllers use the browser `Session` as their client API. In direct mode, the browser runs both `Session` and `Host`, with
in-process delivery handled by `Session`. Hosted setup has its own Connection page; afterward, `Session` reaches the server-side `Host` through
WebSocket and the Node server. Both return the same
`{ view, message, data }` envelope. See the [runtime architecture](docs/pick-2.md#31-runtime-architecture) for the
request flow and file map.

`CardCollection` supplies every card-storage role. Pick 2 owns its card, Room, actor, turn-order, runtime, and UI
foundations directly, without single-use base layers.

See the [Pick 2 software design and maintenance reference](docs/pick-2.md) for architecture, runtime flows, domain
contracts, card interaction, testing, and operations.

## License and copyright

Copyright © Pick 2. All rights reserved.

This software is proprietary and is not free or open-source software. No permission is granted to copy, modify,
distribute, sublicense, or use it outside the terms provided by its owner.
