# Team roster

112 agents in 12 departments. Each is a file in `.claude/agents/`; the name is how you call them. How the team works together is in [CHARTER.md](CHARTER.md).

## Program & Delivery

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `ron` | Program Director | sonnet | which delivery model each piece of work runs under, stage-gate approvals, cross-team sequencing and escalation |
| `pia` | Product Owner | sonnet | the backlog, user stories, acceptance criteria and priority against docs/product-spec.md |
| `sam` | Scrum Master | haiku | two-week sprints, ceremonies, impediments and flow metrics |
| `ivy` | Business Analyst | sonnet | requirements, use cases and the traceability matrix from spec section to test |
| `gus` | Project Planner | sonnet | work-breakdown structures, critical-path schedules and PERT estimates for gated work |
| `nell` | Risk & Compliance Manager | sonnet | the risk register, RAID log and release risk review |
| `kit` | Release Manager | sonnet | version bumps, apps/desktop/CHANGELOG.md, the What's new copy and release readiness |
| `lou` | Technical Writer | sonnet | docs/, READMEs, and the written explanation behind each feature |
| `bea` | Estimation & Metrics Analyst | haiku | velocity, burn-down, cycle-time distributions and forecast ranges |
| `hank` | Engineering Manager | haiku | team capacity, code-review policy, hand-off quality and who should own what |

## Architecture

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `vic` | Chief Architect | opus | system boundaries across the Tauri shell, React UI, Rust core and optional cloud API |
| `rae` | Rust & Backend Architect | opus | the src-tauri module layout, command surface, error model and async design |
| `ned` | Frontend Architect | opus | the React app's module boundaries, store design and rendering strategy |
| `ada` | Data & Schema Architect | opus | how QluePrint models schemas, tables, keys and relationships it reads from four engines |
| `sol` | Security Architect | opus | the trust model: credentials, audit integrity, local-first data and the optional cloud |
| `max` | API & Integration Architect | sonnet | contracts between the desktop app and apps/api, and with external identity providers |
| `uma` | Performance Architect | opus | performance budgets for large schemas, large result sets and cold start |

## Frontend

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `tom` | State Management Engineer | sonnet | the Zustand stores in apps/desktop/src/stores and their persistence |
| `liv` | Results Grid Engineer | sonnet | ResultsGrid, virtualised rows and column behaviour in src/components/workspace |
| `gil` | SQL Editor Engineer | sonnet | the Monaco integration in SqlEditor.tsx and src/lib/monaco*.ts |
| `eli` | SQL Autocomplete Engineer | sonnet | sql-complete, sql-refs, sql-lint and where-suggest in src/lib |
| `ben` | Schema Diagram Engineer | sonnet | the diagram view: src/components/diagram, schema-graph.ts, schema-ddl.ts and stores/diagram.ts |
| `joy` | Explorer Tree Engineer | sonnet | Explorer.tsx: the connection > schema > table tree, filtering and context menus |
| `abe` | Data Editing Engineer | sonnet | staged cell edits, undo/redo and the Changes panel (stores/query.ts, ChangesPanel.tsx) |
| `cass` | Dialogs & Forms Engineer | sonnet | dialogs, forms and menus built on Radix and shadcn in src/components/ui |
| `dex` | Keyboard & Command Palette Engineer | sonnet | shortcuts, the command palette and focus management |
| `fay` | Motion Engineer | sonnet | src/lib/spring.tsx and every animated transition |
| `ian` | Theming & Tokens Engineer | sonnet | Tailwind 4 theme variables and light/dark in src/index.css |
| `jo` | Frontend Performance Engineer | sonnet | render cost, bundle size and React Compiler compatibility |
| `kay` | Accessibility Engineer | sonnet | semantic markup, focus, roles and screen-reader behaviour across the UI |
| `len` | Filtering Engineer | sonnet | WhereBar, ColumnFilterForm and lib/column-filter.ts |
| `moe` | Value & Inspector Engineer | sonnet | ValuePanel, TableInspector and cell formatting for JSON, dates, binaries and enums |
| `nat` | Settings & Onboarding Engineer | sonnet | Settings, the welcome screen, What's new and update flows |
| `ozzy` | Frontend Test Engineer | sonnet | Vitest, Testing Library and Playwright coverage of the UI |
| `pat` | TypeScript Engineer | sonnet | strict typing, the generated src/bindings.ts and shared types |
| `rue` | Import, Export & Clipboard Engineer | sonnet | row-copy, CSV/TSV export and clipboard formats |
| `rex` | Schedules & Audit UI Engineer | sonnet | SchedulesPage, AuditLog and their lists and details |

## Design

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `sue` | UX Research Lead | sonnet | who the users are and what they struggle with: developers, DBAs, occasional database users |
| `tai` | Lead UI Designer (Obsidian Flow) | sonnet | the Obsidian Flow visual language in docs/design and docs/design-system.md |
| `una` | Typography Specialist | sonnet | type scale, quotes, dashes, spacing and numeric alignment |
| `vera` | Interaction & Motion Designer | sonnet | interaction flows, feedback and motion specs |
| `wes` | Design Systems Lead | sonnet | tokens, components and the rules in docs/design-system.md |
| `xan` | Iconography & Brand Designer | haiku | icons, engine logos and docs/brand |
| `yara` | UX Writer | sonnet | labels, errors, empty states and confirmations |
| `zack` | Design Accessibility Auditor | sonnet | contrast, target sizes, focus order and reduced-motion in designs before build |

## Rust & Backend

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `dave` | Tauri Command Engineer | sonnet | src-tauri/src/lib.rs, the command surface, permissions and generated bindings |
| `torry` | Connection Pool Engineer | sonnet | src-tauri/src/db.rs: open connections, pools and per-database routing |
| `hugh` | Query Execution Engineer | sonnet | src-tauri/src/query.rs: run_query, result sets, row caps and apply_edits |
| `finn` | PostgreSQL Driver Engineer | sonnet | the sqlx Postgres paths and catalog queries |
| `gwen` | MySQL & MariaDB Driver Engineer | sonnet | the sqlx MySQL paths and information_schema queries |
| `hal` | SQLite Driver Engineer | sonnet | the sqlx SQLite paths and pragma-based inspection |
| `ines` | SQL Server Driver Engineer | sonnet | src-tauri/src/mssql.rs and vendor/tiberius (QLUEPRINT_PATCH.md) |
| `jack` | Cancellation & Streaming Engineer | sonnet | query cancellation, timeouts and incremental delivery of rows |
| `kira` | Type Decoding Engineer | sonnet | converting each engine's types into display text without loss |
| `leo` | Query Plan Engineer | sonnet | src-tauri/src/plan.rs and how plans are parsed and shown |
| `mara` | Scheduler & Tray Engineer | sonnet | src-tauri/src/scheduler.rs and tray-resident background running |
| `nico` | Credentials & Saved Connections Engineer | sonnet | src-tauri/src/saved.rs and keyring use |
| `opal` | Audit Log Engineer | sonnet | src-tauri/src/audit.rs: the hash-chained, tamper-evident log |
| `pete` | Local Docker Provisioning Engineer | sonnet | src-tauri/src/local/docker.rs and the provisioning plan |
| `quinn` | Native Servers & Ports Engineer | sonnet | src-tauri/src/local/native.rs, process.rs and ports.rs |
| `ross` | Rust Error & Safety Engineer | sonnet | CommandError, error codes and unsafe-free guarantees across src-tauri |
| `sid` | Async & Concurrency Engineer | sonnet | Tokio task design, locks and shared state in the core |
| `tess` | Microsoft Identity Engineer | sonnet | src-tauri/src/entra.rs: Microsoft Entra sign-in and token handling |
| `ugo` | Updater & Packaging Engineer | sonnet | the Tauri updater, signatures and update manifests |
| `vance` | Rust Test & Lint Engineer | sonnet | cargo test, clippy and fmt across src-tauri |

## Database Specialists

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `wade` | PostgreSQL Internals Specialist | sonnet | MVCC, vacuum, planner, pg_catalog and extensions |
| `xena` | MySQL & MariaDB Specialist | sonnet | InnoDB, optimiser behaviour, sql_mode and version differences |
| `yuri` | SQLite Specialist | sonnet | file format, WAL, pragmas, type affinity and ALTER limits |
| `zoe` | SQL Server Specialist | sonnet | T-SQL, query store, execution plans, schemas and permissions |
| `amos` | Query Optimisation Specialist | sonnet | reading EXPLAIN output and finding the dominant cost |
| `bram` | DDL & Migration Safety Specialist | sonnet | which schema changes lock, rewrite or fail, per engine |
| `cleo` | Indexing Specialist | sonnet | index design, selectivity and covering indexes |
| `drew` | Transactions & Locking Specialist | sonnet | isolation levels, deadlocks and long-running transaction risks |
| `edie` | Backup & Replication Specialist | sonnet | dump and restore, point-in-time recovery and replication topology |
| `fred` | Data Modelling Specialist | sonnet | normalisation, keys, ERD semantics and relationship cardinality |

## Cloud & API

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `gabe` | Fastify API Engineer | sonnet | apps/api/src: app, routes, plugins and modules |
| `hope` | Drizzle & Neon Engineer | sonnet | apps/api drizzle schema, migrations and the Neon database |
| `ike` | Auth & JWT Engineer | sonnet | apps/api auth plugin and Neon Auth token verification |
| `jade` | Collaboration Engineer | sonnet | the optional shared-workspace design in spec section 7 |
| `kurt` | API Contract Engineer | sonnet | OpenAPI documents, versioning and client typing for apps/api |

## Security

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `lena` | Application Security Lead | opus | secure-code review, injection and secret-handling risks |
| `milo` | Applied Cryptography Engineer | sonnet | hashing, signatures, key storage and randomness |
| `nora` | Threat Modelling Specialist | sonnet | STRIDE models for each feature before design is frozen |
| `owen` | Supply Chain Security Engineer | sonnet | dependencies, lockfiles, cargo-deny and pnpm audit |
| `paige` | Privacy & Compliance Specialist | sonnet | what data stays local, retention, and GDPR and SOC 2 expectations |
| `quill` | Defensive Security Tester | sonnet | authorised security testing of QluePrint's own builds and fixtures |

## Quality Assurance

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `reid` | Test Architect | sonnet | the test strategy and pyramid across Rust, UI and end-to-end |
| `sana` | Unit Test Engineer | sonnet | unit tests for pure logic in src/lib and Rust modules |
| `toby` | End-to-End Test Engineer | sonnet | Playwright and desktop-driver flows through real connections |
| `ula` | Performance Test Engineer | sonnet | benchmarks for big schemas, big results and cold start |
| `vito` | Fuzz & Property Testing Engineer | sonnet | proptest, fuzzing and generated inputs for parsers, quoting and DDL |
| `wren` | Accessibility Test Engineer | sonnet | automated and manual accessibility checks |
| `xiu` | Cross-Platform Compatibility Tester | sonnet | Windows, macOS and Linux behaviour of the desktop shell |
| `yan` | Exploratory Tester & Triage | haiku | exploratory sessions, bug triage and reproduction steps |
| `zane` | Test Data Engineer | sonnet | fixtures, seeded databases and realistic data volumes |

## DevOps & Release

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `alma` | CI/CD Engineer | sonnet | pipelines that build, test and sign every platform |
| `bo` | Build Engineer | sonnet | cargo and vite build performance and reproducibility |
| `cy` | Code Signing & Notarisation Engineer | sonnet | Windows signing, Apple notarisation and key custody |
| `dina` | Installer & Packaging Engineer | sonnet | MSI, NSIS, dmg and Linux packages |
| `emil` | Diagnostics & Observability Engineer | sonnet | local logs, crash reports and diagnostics without telemetry |
| `faye` | Release Automation Engineer | sonnet | update manifests, channel promotion and rollback |
| `glen` | Dependency Steward | haiku | scheduled dependency updates and lockfile hygiene |
| `hugo` | Reliability & Incident Engineer | sonnet | incident response, post-mortems and release-day readiness |

## Algorithms & Data Structures

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `iris` | Graph Algorithms Engineer | sonnet | layered layout, topological order, cycles and reachability for the diagram |
| `jude` | String Algorithms Engineer | sonnet | searching and matching: substring, regex and fuzzy |
| `kai` | Parser & Compiler Engineer | sonnet | tokenising, parsing and analysing SQL text |
| `lola` | Text Buffer Engineer | sonnet | large-text storage and edits: ropes, piece tables and gap buffers |
| `moss` | Caching & Indexing Engineer | sonnet | in-memory caches and lookup structures: LRU, ARC, tries and inverted indexes |
| `nia` | Complexity & Benchmark Engineer | sonnet | big-O budgets, benchmarks and regressions |

## Docs & Support

| Agent | Role | Model | Owns |
| --- | --- | --- | --- |
| `otto` | Documentation Engineer | haiku | docs-as-code: structure, linting and keeping docs in step with code |
| `pru` | Support Engineer | haiku | turning user reports into reproducible issues and known-issue notes |
| `ravi` | Localisation Engineer | sonnet | internationalisation, locale formatting and right-to-left readiness |
