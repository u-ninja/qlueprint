# QueryCraft

A local-first database workspace for the desktop: connect to databases, write and run SQL, browse data, inspect schemas, and spin up local database servers in one click. No account required.

![QueryCraft workspace concept](docs/assets/concept-local-servers.png)

<sub>Design concept. QueryCraft is in early development; the app does not look like this yet.</sub>

<details>
<summary>More concepts</summary>

| SQL workspace                                       | Local workspace home                                            |
| --------------------------------------------------- | --------------------------------------------------------------- |
| ![SQL workspace](docs/assets/workspace-concept.png) | ![Local workspace home](docs/assets/concept-workspace-home.png) |

</details>

## About

QueryCraft is a desktop database IDE for developers and DBAs. It aims to be as capable as established database tools while staying approachable for people who don't work with databases every day.

- **Local-first.** Install it and use it. Everything except team collaboration works without signing in, without a cloud service, and offline.
- **One app for the whole workflow.** Connections, schema explorer, SQL editor, results grid, query history, and snippets live in one workspace.
- **Local database servers.** Create a SQLite database, or a PostgreSQL or MySQL server, from inside the app, with its connection set up for you.
- **Optional collaboration.** Sign in only if you want shared workspaces and live SQL documents. Sharing a query never shares your database credentials.
- **Light and dark themes.** Both are first-class, along with keyboard navigation and accessible contrast.

The full product, design system, and architecture specification is in [docs/product-spec.md](docs/product-spec.md).

## Status

Early development. Nothing here is ready for real use yet.

| Area                                               | State                           |
| -------------------------------------------------- | ------------------------------- |
| Desktop shell (Tauri 2 + React)                    | Scaffolded                      |
| Local backend (Rust, inside the Tauri app)         | Not started                     |
| Cloud API (Fastify + Drizzle + PostgreSQL)         | Scaffolded, with a users module |
| Cloud sign-in (Neon Auth: Google + email/password) | Working prototype               |
| Database connections, SQL editor, results grid     | Not started                     |
| Local server provisioning                          | Not started                     |
| Collaboration                                      | Not started                     |

Windows is the first release target; the code is kept cross-platform and is currently developed on macOS.

## Tech stack

| Layer                 | Technology                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop UI            | [Tauri 2](https://tauri.app), React 19, TypeScript, Vite                                                                              |
| Local backend         | Rust inside the Tauri app: database drivers, OS keychain, local server management. No separate local server or open port.             |
| Cloud API             | Node.js, [Fastify 5](https://fastify.dev), [Drizzle ORM](https://orm.drizzle.team). Only used for optional sign-in and collaboration. |
| Cloud database & auth | PostgreSQL on [Neon](https://neon.com), Neon Auth                                                                                     |
| Package manager       | pnpm                                                                                                                                  |

Planned additions such as Monaco Editor, Tailwind CSS, and shadcn/ui are listed in the [spec](docs/product-spec.md#21-desktop-application).

## Repository layout

```text
querycraft/
├── apps/
│   ├── api/          # Cloud API (Fastify, Drizzle migrations in drizzle/): sign-in, collaboration
│   └── desktop/      # Tauri 2 app: React UI in src/, Rust local backend in src-tauri/
└── docs/
    └── product-spec.md
```

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) (current LTS or newer)
- [pnpm](https://pnpm.io)
- [Rust](https://www.rust-lang.org/tools/install) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS
- A PostgreSQL database with Neon Auth enabled (only needed for the cloud API and sign-in)

### Cloud API (optional)

Only needed for sign-in. The desktop app is meant to work without it.

```sh
cd apps/api
pnpm install
```

Create `apps/api/.env`:

```sh
DATABASE_URL=postgres://...         # PostgreSQL connection string
NEON_AUTH_URL=https://...           # Neon Auth base URL
PORT=8080                           # optional, defaults to 8080
CORS_ORIGIN=http://localhost:1420   # optional, comma-separated origins
```

Then run the migrations and start the server:

```sh
pnpm db:migrate
pnpm dev
```

### Desktop app

```sh
cd apps/desktop
pnpm install
```

Create `apps/desktop/.env`:

```sh
VITE_NEON_AUTH_URL=https://...      # same Neon Auth base URL as the API
VITE_API_URL=http://localhost:8080  # where the API is running
```

Then start the app:

```sh
pnpm tauri dev
```

## Documentation

- [Product, UX, design system & local provisioning spec](docs/product-spec.md)
- [Interactive design prototype](docs/design/README.md)
- [Tech stack](docs/tech-stack.md)

## License

Not yet licensed. All rights reserved until a license is added.
