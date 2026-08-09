# Pick 2

Pick 2 is a multiplayer shedding card game with two browser editions built
from the same rules and interface source:

- **Server:** shared rooms for people, AI players, and visitors over WebSockets.
- **Static:** one browser-local table with one human and three AI players,
  deployable to GitHub Pages.

The shared source folders are the only authoritative copies of card rules, AI
behavior, common controllers, card rendering, styles, templates, and artwork.

## Requirements

- Node.js 22
- npm

## Install

```bash
npm install
```

## Run the server edition

```bash
npm start
```

Open [http://localhost:8080](http://localhost:8080). Development watch mode is
available through `npm run dev`.

## Open the static edition

The static edition starts at the repository's root `index.html`. Serve the
repository root with IntelliJ's built-in web server to run it locally. It uses
the shared source and web assets directly, so there is no build output.

Publish the static edition manually using the hosting provider and release
process of your choice. This repository does not automatically publish changes
when `main` is pushed.

The published page declares its canonical URL and includes a root-level
`sitemap.xml`. After the first deployment, add
`https://danieltongu.github.io/pick-2/` as a URL-prefix property in Google
Search Console, submit `https://danieltongu.github.io/pick-2/sitemap.xml`, and
request indexing for the canonical page. Search engines decide when and whether
to index a page, so publication alone does not guarantee immediate appearance.

Each browser tab runs an independent static match; a static host cannot share a
room across browsers without an external realtime service.

## Test

```bash
npm test
```

Coverage reporting is available through `npm run test:coverage`.

## Project structure

```text
index.html              Static-edition entry point for GitHub Pages
src/
  core/                  Cards, collections, room rules, AI, state mapping
  ui/                    Shared controllers, elements, and browser utilities
  server/                Server runtime, lobby, and networked controllers
  static/                Browser-local service and AI-table controllers
web/
  shared/                Shared CSS, templates, images, and artwork
  server/                Server-edition HTML
  static/                Static-edition layout additions
test/                    Shared, server, and static tests
docs/                    Design and maintenance documentation
```

Every JavaScript file lives under `src`. Its four flat folders describe whether
a file contains shared rules, shared browser UI, server-edition behavior, or
static-edition behavior. Relative imports cross at most one source boundary,
such as `../core/Room.js` or `../ui/PlayingCard.js`.

The server exposes the shared source and web assets directly. GitHub Pages uses
the root entry point and the same files in place. Nothing is copied or generated.

## Technology

- JavaScript ES modules
- Node.js, Express 5, and WebSockets through `ws`
- Semantic HTML and mobile-first CSS
- Node's built-in test runner
- Static hosting support for the browser-only edition

## Documentation

See [Software documentation](docs/software-documentation.md) for game flow,
protocol details, data contracts, and extension guidance.

## License and copyright

Copyright © Pick 2. All rights reserved.

This software is proprietary and is not free or open-source software. No
permission is granted to copy, modify, distribute, sublicense, or use it outside
the terms provided by its owner.
