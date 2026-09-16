# Pick 2

Pick 2 is a browser shedding-card game with two play modes built from the same Home and Room pages, controllers,
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

The canonical public URL is `https://danieltongu.github.io/pick-2/`, and the root `sitemap.xml` contains that page.

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
├── index.js                Home and Room application entry point
├── server.js              Hosted Node entry point
├── core/                   Cards, collections, actors, turns, rules, hosting, bots, and mapping
├── runtime/                Direct and Hosted connection infrastructure
├── ui/                     Pages, cards, controllers, styles, templates, and artwork
├── test/                   Pick 2, infrastructure, and navigation tests
└── docs/                   Design and maintenance documentation
```

The Home and Room controllers use one `Client` API. Direct play connects it to an in-browser, transport-neutral `Host`;
Hosted play uses `NetworkClient` and the Node-only `Network` boundary. Both return the same `{ view, message, data }`
envelope.

`CardCollection` supplies every card-storage role. Pick 2 owns its card, Room, actor, turn-order, runtime, and UI
foundations directly, without single-use base layers.

See the [Pick 2 software design and maintenance guide](docs/pick-2.md) for architecture, runtime flows, domain
contracts, card interaction, testing, and operations.

## License and copyright

Copyright © Pick 2. All rights reserved.

This software is proprietary and is not free or open-source software. No permission is granted to copy, modify,
distribute, sublicense, or use it outside the terms provided by its owner.
