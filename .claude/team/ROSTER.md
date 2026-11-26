# Team roster

44 agents in 11 departments, four each. Each is a file in `.claude/agents/`; the name is how you call them. How the team works together is in [CHARTER.md](CHARTER.md).

## Program & Delivery

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `ron` | Program Director & Delivery Lead | sonnet | Which delivery model each piece of work runs under, stage-gate approvals, cross-team sequencing and escalation; Two-week sprints, ceremonies, impediments and flow metrics; Work-breakdown structures, critical-path schedules and PERT estimates for gated work; Team capacity, code-review policy, hand-off quality and who should own what; Velocity, burn-down, cycle-time distributions and forecast ranges; The risk register, RAID log and release risk review |
| `pia` | Product Owner & Analyst | sonnet | The backlog, user stories, acceptance criteria and priority against docs/product-spec.md; Requirements, use cases and the traceability matrix from spec section to test |
| `kit` | Release Manager | sonnet | Version bumps, apps/desktop/CHANGELOG.md, the What's new copy and release readiness |
| `lou` | Technical Writer & Support | sonnet | Docs/, READMEs, and the written explanation behind each feature; Docs-as-code: structure, linting and keeping docs in step with code; Turning user reports into reproducible issues and known-issue notes |

## Architecture

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `vic` | Chief Architect | opus | System boundaries across the Tauri shell, React UI, Rust core and optional cloud API |
| `rae` | Rust & Backend Architect | opus | The src-tauri module layout, command surface, error model and async design; Tokio task design, locks and shared state in the core; CommandError, error codes and unsafe-free guarantees across src-tauri |
| `ned` | Frontend Architect | opus | The React app's module boundaries, store design and rendering strategy |
| `uma` | Performance Architect | opus | Performance budgets for large schemas, large result sets and cold start |

## Frontend

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `tom` | State, Types & Performance Engineer | sonnet | The Zustand stores in apps/desktop/src/stores and their persistence; Strict typing, the generated src/bindings.ts and shared types; Render cost, bundle size and React Compiler compatibility |
| `liv` | Grid, Editing & Filtering Engineer | sonnet | ResultsGrid, virtualised rows and column behaviour in src/components/workspace; Staged cell edits, undo/redo and the Changes panel (stores/query.ts, ChangesPanel.tsx); WhereBar, ColumnFilterForm and lib/column-filter.ts; Row-copy, CSV/TSV export and clipboard formats; ValuePanel, TableInspector and cell formatting for JSON, dates, binaries and enums |
| `ben` | Diagram & Explorer Engineer | sonnet | The diagram view: src/components/diagram, schema-graph.ts, schema-ddl.ts and stores/diagram.ts; Explorer.tsx: the connection > schema > table tree, filtering and context menus; Layered layout, topological order, cycles and reachability for the diagram |
| `nat` | Settings, Dialogs & Schedules Engineer | sonnet | Settings, the welcome screen, What's new and update flows; Dialogs, forms and menus built on Radix and shadcn in src/components/ui; SchedulesPage, AuditLog and their lists and details; Shortcuts, the command palette and focus management |

## Design

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `tai` | Lead UI Designer (Obsidian Flow) | sonnet | The Obsidian Flow visual language in docs/design and docs/design-system.md; Tokens, components and the rules in docs/design-system.md; Tailwind 4 theme variables and light/dark in src/index.css; Icons, engine logos and docs/brand |
| `una` | Typography, UX Writing & Localisation Specialist | sonnet | Type scale, quotes, dashes, spacing and numeric alignment; Labels, errors, empty states and confirmations; Internationalisation, locale formatting and right-to-left readiness |
| `vera` | Interaction, Motion & Research Designer | sonnet | Interaction flows, feedback and motion specs; Src/lib/spring.tsx and every animated transition; Who the users are and what they struggle with: developers, DBAs, occasional database users |
| `zack` | Accessibility Lead | sonnet | Contrast, target sizes, focus order and reduced-motion in designs before build; Semantic markup, focus, roles and screen-reader behaviour across the UI; Automated and manual accessibility checks |

## Rust & Backend

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `dave` | Tauri Command & Updater Engineer | sonnet | Src-tauri/src/lib.rs, the command surface, permissions and generated bindings; The Tauri updater, signatures and update manifests; Cargo test, clippy and fmt across src-tauri |
| `torry` | Connections & Credentials Engineer | sonnet | Src-tauri/src/db.rs: open connections, pools and per-database routing; Src-tauri/src/saved.rs and keyring use |
| `hugh` | Query Execution Engineer | sonnet | Src-tauri/src/query.rs: run_query, result sets, row caps and apply_edits; Query cancellation, timeouts and incremental delivery of rows; Src-tauri/src/plan.rs and how plans are parsed and shown; Converting each engine's types into display text without loss |
| `pete` | Local Servers & Scheduler Engineer | sonnet | Src-tauri/src/local/docker.rs and the provisioning plan; Src-tauri/src/local/native.rs, process.rs and ports.rs; Src-tauri/src/scheduler.rs and tray-resident background running |

## Database Specialists

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `finn` | PostgreSQL Engineer & Specialist | sonnet | The sqlx Postgres paths and catalog queries; MVCC, vacuum, planner, pg_catalog and extensions |
| `gwen` | MySQL & MariaDB Engineer & Specialist | sonnet | The sqlx MySQL paths and information_schema queries; InnoDB, optimiser behaviour, sql_mode and version differences |
| `hal` | SQLite & SQL Server Engineer & Specialist | sonnet | The sqlx SQLite paths and pragma-based inspection; File format, WAL, pragmas, type affinity and ALTER limits; Src-tauri/src/mssql.rs and vendor/tiberius (QLUEPRINT_PATCH.md); T-SQL, query store, execution plans, schemas and permissions |
| `ada` | Data Architect & Database Specialist | opus | How QluePrint models schemas, tables, keys and relationships it reads from four engines; Normalisation, keys, ERD semantics and relationship cardinality; Which schema changes lock, rewrite or fail, per engine; Index design, selectivity and covering indexes; Isolation levels, deadlocks and long-running transaction risks; Reading EXPLAIN output and finding the dominant cost; Dump and restore, point-in-time recovery and replication topology |

## Cloud & API

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `gabe` | API & Contract Engineer | sonnet | Apps/api/src: app, routes, plugins and modules; OpenAPI documents, versioning and client typing for apps/api; Contracts between the desktop app and apps/api, and with external identity providers |
| `hope` | Drizzle & Neon Engineer | sonnet | Apps/api drizzle schema, migrations and the Neon database |
| `ike` | Auth & Identity Engineer | sonnet | Apps/api auth plugin and Neon Auth token verification; Src-tauri/src/entra.rs: Microsoft Entra sign-in and token handling |
| `jade` | Collaboration Engineer | sonnet | The optional shared-workspace design in spec section 7 |

## Security

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `sol` | Security Architect & Threat Modeller | opus | The trust model: credentials, audit integrity, local-first data and the optional cloud; STRIDE models for each feature before design is frozen |
| `lena` | Application Security Lead & Tester | opus | Secure-code review, injection and secret-handling risks; Authorised security testing of QluePrint's own builds and fixtures |
| `milo` | Cryptography & Audit Log Engineer | sonnet | Hashing, signatures, key storage and randomness; Src-tauri/src/audit.rs: the hash-chained, tamper-evident log |
| `owen` | Supply Chain & Privacy Specialist | sonnet | Dependencies, lockfiles, cargo-deny and pnpm audit; What data stays local, retention, and GDPR and SOC 2 expectations |

## Quality

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `reid` | Test Architect & Performance Tester | sonnet | The test strategy and pyramid across Rust, UI and end-to-end; Benchmarks for big schemas, big results and cold start; Big-O budgets, benchmarks and regressions |
| `ozzy` | Frontend & Unit Test Engineer | sonnet | Vitest, Testing Library and Playwright coverage of the UI; Unit tests for pure logic in src/lib and Rust modules |
| `toby` | End-to-End & Cross-Platform Tester | sonnet | Playwright and desktop-driver flows through real connections; Windows, macOS and Linux behaviour of the desktop shell; Exploratory sessions, bug triage and reproduction steps |
| `vito` | Fuzz & Test Data Engineer | sonnet | Proptest, fuzzing and generated inputs for parsers, quoting and DDL; Fixtures, seeded databases and realistic data volumes |

## DevOps & Release

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `alma` | CI/CD & Build Engineer | sonnet | Pipelines that build, test and sign every platform; Cargo and vite build performance and reproducibility; Scheduled dependency updates and lockfile hygiene |
| `cy` | Code Signing & Notarisation Engineer | sonnet | Windows signing, Apple notarisation and key custody |
| `dina` | Installer & Update Delivery Engineer | sonnet | MSI, NSIS, dmg and Linux packages; Update manifests, channel promotion and rollback |
| `hugo` | Reliability & Diagnostics Engineer | sonnet | Incident response, post-mortems and release-day readiness; Local logs, crash reports and diagnostics without telemetry |

## Algorithms & Editor

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `kai` | Parser, Autocomplete & Editor Engineer | sonnet | Tokenising, parsing and analysing SQL text; Sql-complete, sql-refs, sql-lint and where-suggest in src/lib; The Monaco integration in SqlEditor.tsx and src/lib/monaco*.ts |
| `lola` | Text Buffer Engineer | sonnet | Large-text storage and edits: ropes, piece tables and gap buffers |
| `jude` | Search & Matching Engineer | sonnet | Searching and matching: substring, regex and fuzzy |
| `moss` | Caching & Indexing Engineer | sonnet | In-memory caches and lookup structures: LRU, ARC, tries and inverted indexes |
