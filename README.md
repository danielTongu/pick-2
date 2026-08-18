# Pick 2

Pick 2 is a shedding card game with two play modes built from the same pages,
controllers, protocol, and game rules:

- **Local:** browser-local sessions with one human and `capacity - 1` AI players.
- **Server:** shared sessions for people, AI players, and viewers over WebSockets.

The shared source folders are the only authoritative copies of card rules, AI
behavior, common controllers, card rendering, styles, templates, and artwork.

## Requirements

- Node.js 22
- npm

## Install

```bash
npm install
```

## Run locally with the server

```bash
npm start
```

Open [http://localhost:8080](http://localhost:8080). Development watch mode is
available through `npm run dev`.

## Use static hosting

The shared game starts at the root `index.html`; the shared session and game guide
live at `session/index.html`. Serve the repository root with any static web server.
Local play is always available and is the default. The game enables Server
mode when its configured WebSocket server is reachable.

Publish the static deployment manually using the hosting provider and release
process of your choice. This repository does not automatically publish changes
when `main` is pushed.

The published page declares its canonical URL and includes a root-level
`sitemap.xml`. After the first deployment, add
`https://danieltongu.github.io/pick-2/` as a URL-prefix property in Google
Search Console, submit `https://danieltongu.github.io/pick-2/sitemap.xml`, and
request indexing for the canonical page. Search engines decide when and whether
to index a page, so publication alone does not guarantee immediate appearance.

Local and Server registries use the same `Constants.DEFAULT_SESSIONS` definitions.
Each browser tab runs its own Local match. User-created Local sessions appear in
the browser registry while active and are removed when their player leaves;
default sessions remain available. Capacity ranges from two to four and includes
the human seat. A static host cannot share live state across browsers without
the Server mode.

## Test

```bash
npm test
```

Coverage reporting is available through `npm run test:coverage`.

## Project structure

```text
index.html              Shared Game and session registry
session/index.html      Shared Session and guide
src/
  client/                GameClient and interchangeable transports
  core/                  Cards, collections, session rules, AI, state mapping
  local/                 In-browser LocalServer
  server/                Express and WebSocket Server
  ui/                    Shared page controllers, elements, and utilities
web/
  shared/                Shared CSS, templates, images, and artwork
test/                    Domain, protocol, local, and infrastructure tests
docs/                    Design and maintenance documentation
```

The game and session controllers use one `GameClient` API. `LocalTransport` sends
the canonical actions to `LocalServer`; `WebSocketTransport` sends the same
actions to `Server`. Both return the same `{ view, message, sync }` envelope.

The Node server and static hosts serve the exact same HTML, source, and web
assets. Nothing is copied or generated.

## Technology

- JavaScript ES modules
- Node.js, Express 5, and WebSockets through `ws`
- Semantic HTML and mobile-first CSS
- Node's built-in test runner
- Static hosting with Local play and optional Server availability

## Documentation

See [Software documentation](docs/software-documentation.md) for game flow,
protocol details, data contracts, and extension guidance.

## License and copyright

Copyright © Pick 2. All rights reserved.

This software is proprietary and is not free or open-source software. No
permission is granted to copy, modify, distribute, sublicense, or use it outside
the terms provided by its owner.
