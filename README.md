# Pick 2

Pick 2 is a shedding card game with two play modes built from the same pages,
controllers, protocol, and game rules:

- **Local:** browser-local rooms; custom rooms fill their open seats with bots.
- **Network:** shared rooms for people, configured bot players, and viewers over WebSockets.

The shared source folders are the only authoritative copies of card rules, bot
behavior, common controllers, card rendering, styles, templates, and artwork.

## Requirements

- Node.js 22
- npm

## Install

```bash
npm install
```

## Run the Network host

```bash
npm start
```

Open [http://localhost:8080](http://localhost:8080). Development watch mode is
available through `npm run dev`.

## Use static hosting

The Home page and room directory start at the root `index.html`; an active Room
and its guide live at `room.html`. Serve the repository root with any static
web server. Local play is always available and is the default. The Home page
enables Network mode when its configured WebSocket host is reachable.

Publish the static deployment manually using the hosting provider and release
process of your choice. This repository does not automatically publish changes
when `main` is pushed.

The published page declares its canonical URL and includes a root-level
`sitemap.xml`. After the first deployment, add
`https://danieltongu.github.io/pick-2/` as a URL-prefix property in Google
Search Console, submit `https://danieltongu.github.io/pick-2/sitemap.xml`, and
request indexing for the canonical page. Search engines decide when and whether
to index a page, so publication alone does not guarantee immediate appearance.

Local and Network registries use the same `Constants.DEFAULT_ROOMS` definitions.
Each browser tab runs its own Local match. User-created Local rooms appear in
the Home room directory while active and are removed when their player leaves;
rooms backed by the default `Room` definitions remain available with only
their configured bot players, so any other seats remain open for humans. Player limit
ranges from two to four and includes the human seat. A static host cannot share
live state across browsers without Network mode.

## Test

```bash
npm test
```

Coverage reporting is available through `npm run test:coverage`.

## Project structure

```text
index.html              Shared Home page and room directory
room.html               Shared active Room and guide
core/                    Cards, collections, game rules, bot behavior, state mapping
runtime/                Client, Host, browser and Network boundaries
ui/                     Shared page controllers, styles, templates, and utilities
server.js                Node Network runtime entry point
test/                    Domain, protocol, local, and infrastructure tests
docs/                    Design and maintenance documentation
```

The Home and Room controllers use one `Client` API. Local play connects it
directly to the transport-neutral `Host`; Network play connects it through the
browser-only `NetworkClient` and Node-only `Network` boundary. Both return the
same `{ view, message, data }` envelope.

`Host.js` never imports browser or Node infrastructure. `Browser.js` and
`NetworkClient.js` are browser leaves, while `Network.js` is the only Node
networking leaf. This keeps incompatible runtime imports out of shared graphs.

The Node server and static hosts serve the exact same HTML, JavaScript, styles,
templates, and artwork. Nothing is copied or generated.

## Technology

- JavaScript ES modules
- Node.js, Express 5, and WebSockets through `ws`
- Semantic HTML and mobile-first CSS
- Node's built-in test runner
- Static hosting with Local play and optional Network availability

## Documentation

See [Software documentation](docs/software-documentation.md) for room flow,
protocol details, data contracts, and extension guidance.

## License and copyright

Copyright © Pick 2. All rights reserved.

This software is proprietary and is not free or open-source software. No
permission is granted to copy, modify, distribute, sublicense, or use it outside
the terms provided by its owner.
