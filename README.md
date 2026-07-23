# Foundation

[![Latest Stable Version](https://img.shields.io/npm/v/@sinemacula/foundation.svg)](https://www.npmjs.com/package/@sinemacula/foundation)
[![Build Status](https://github.com/sinemacula/foundation-ts/actions/workflows/tests.yml/badge.svg?branch=master)](https://github.com/sinemacula/foundation-ts/actions/workflows/tests.yml)
[![Quality Gates](https://github.com/sinemacula/foundation-ts/actions/workflows/quality-gates.yml/badge.svg?branch=master)](https://github.com/sinemacula/foundation-ts/actions/workflows/quality-gates.yml)
[![Maintainability](https://qlty.sh/gh/sinemacula/projects/foundation-ts/maintainability.svg)](https://qlty.sh/gh/sinemacula/projects/foundation-ts)
[![Code Coverage](https://qlty.sh/gh/sinemacula/projects/foundation-ts/coverage.svg)](https://qlty.sh/gh/sinemacula/projects/foundation-ts)
[![Total Downloads](https://img.shields.io/npm/dt/@sinemacula/foundation.svg)](https://www.npmjs.com/package/@sinemacula/foundation)

`@sinemacula/foundation` is the platform-agnostic foundation on which Sine Macula application kernels are
built. It provides the framework-free logic every client needs - configuration, HTTP, sessions, queries,
realtime, storage and more - as small, port-driven TypeScript units with no framework, DOM or node-only
dependencies anywhere in the tree.

Applications do not normally consume this package directly: each platform kernel (web, mobile) boots the
foundation core, binds the generic contracts to its own router and UI vocabulary, and layers its platform
services on top. Everything platform-specific arrives through an injected port.

## What lives here

| Area                 | What it provides                                                                                                 | Port / contract           |
|----------------------|------------------------------------------------------------------------------------------------------------------|---------------------------|
| `src/analytics/`     | Records product events through a swappable tracker (console + no-op adapters), plus route page tracking          | `AnalyticsTracker`        |
| `src/app/`           | The boot core: `bootFoundationCore` runs the agnostic phases, plus the service registry and base wiring          | `bootFoundationCore`      |
| `src/authorization/` | Evaluates flat permission grants with wildcard-prefix matching                                                   | `PermissionSet` (no port) |
| `src/config/`        | Reads typed configuration from environment sources, fetches the runtime document and freezes the repository      | `EnvironmentSource`       |
| `src/connectivity/`  | The connectivity-observation contract each platform adapts                                                       | `ConnectivityMonitor`     |
| `src/feature-flags/` | Resolves feature flags through a swappable provider (static adapter included)                                    | `FeatureFlags`            |
| `src/http/`          | HTTP client: a fetch adapter behind a port, a typed error hierarchy, and bearer-token attach + refresh-and-retry | `HttpClient`              |
| `src/i18n/`          | Locale detection, persistence and negotiation, free of any rendering library                                     | `LocaleService`           |
| `src/logging/`       | A minimal logging port with console and no-op adapters                                                           | `Logger`                  |
| `src/notifications/` | The toast and confirm-dialog ports each platform's notification services implement                               | `Toaster` / `Confirmer`   |
| `src/query/`         | Resource queries: the `ApiQuery` builder, a typed filter DSL, envelope mapping and `ResourceClient`              | `ResourceClient`          |
| `src/realtime/`      | Live connections behind a port: WebSocket and EventSource adapters sharing exponential-backoff reconnect         | `RealtimeConnection`      |
| `src/reporting/`     | Error reporting through a swappable reporter and a breadcrumb trail                                              | `ErrorReporter`           |
| `src/router/`        | The navigation middleware contract and pipeline, generic over each platform's route and location types           | `RouteMiddleware`         |
| `src/session/`       | The session core: lifecycle transitions, storage keys, redirect sanitising and a default `/auth` gateway         | `SessionApi`              |
| `src/storage/`       | A synchronous key-value storage port with in-memory and key-namespacing adapters                                 | `KeyValueStorage`         |
| `src/support/`       | Shared primitives: service holders, deep freeze and record guards                                                | -                         |
| `src/theme/`         | Colour-scheme state: preference resolution and the OS-source and applier ports                                   | `ColorSchemeService`      |

## Installation

```bash
npm install @sinemacula/foundation
```

## Import style

The package has no barrel: every module is imported by its explicit subpath, and the manifest `exports` map is
the public-surface allow-list - anything unlisted is internal and unreachable.

```ts
import { Environment } from '@sinemacula/foundation/config/environment';
import { MemoryStorage } from '@sinemacula/foundation/storage/memory-storage';
```

## Bootstrapping

Platform kernels boot the core through `@sinemacula/foundation/app/boot-foundation-core`, supplying their own
storage, notification and fetch seams. The core runs the agnostic boot phases in a fixed order - runtime
environment, configuration, storage, feature flags, notifications, observability and the HTTP client - and
bridges the platform's module-registration step so modules contribute interceptors before the client is built.

```ts
const core = await bootFoundationCore(options, { fetchFn }, runtimeUrl);
```

Everything the core installs is reachable afterwards through the service accessors in
`@sinemacula/foundation/app/services`.

## Quality gates

| Command                 | What it runs                                           |
|-------------------------|--------------------------------------------------------|
| `npm run check`         | Static analysis and lint via qlty (Biome, ESLint)      |
| `npm run typecheck`     | Type-checking with tsc                                 |
| `npm run test:coverage` | The unit suite, with 100% coverage enforced            |
| `npm run test:mutation` | Mutation testing with Stryker                          |
| `npm run deadcode`      | Dead-code detection with knip                          |
| `npm run check:pkg`     | Packaging checks (publint + attw) on the built tarball |

## Releases

Releases are cut by release-please from Conventional Commit history and published to npm by CI through OIDC
trusted publishing; the pack lifecycle compiles `dist/` and rewrites the manifest `exports` to its published
form.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on branching, commits,
code quality, and pull requests.

## Security

If you discover a security vulnerability, please report it responsibly. See [SECURITY.md](SECURITY.md) for the
disclosure policy and contact details.

## License

Licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0).
