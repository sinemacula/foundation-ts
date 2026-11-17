<h1 align="center">Foundation</h1>

<div align="center">

[![Latest Stable Version](https://img.shields.io/npm/v/@sinemacula/foundation.svg)](https://www.npmjs.com/package/@sinemacula/foundation)
[![Node Version](https://img.shields.io/node/v/@sinemacula/foundation.svg)](https://www.npmjs.com/package/@sinemacula/foundation)
[![Build Status](https://github.com/sinemacula/foundation-ts/actions/workflows/tests.yml/badge.svg?branch=master)](https://github.com/sinemacula/foundation-ts/actions/workflows/tests.yml)
[![Quality Gates](https://github.com/sinemacula/foundation-ts/actions/workflows/quality-gates.yml/badge.svg?branch=master)](https://github.com/sinemacula/foundation-ts/actions/workflows/quality-gates.yml)
[![Maintainability](https://qlty.sh/gh/sinemacula/projects/foundation-ts/maintainability.svg)](https://qlty.sh/gh/sinemacula/projects/foundation-ts)
[![Code Coverage](https://qlty.sh/gh/sinemacula/projects/foundation-ts/coverage.svg)](https://qlty.sh/gh/sinemacula/projects/foundation-ts)
[![Total Downloads](https://img.shields.io/npm/dt/@sinemacula/foundation.svg)](https://www.npmjs.com/package/@sinemacula/foundation)
[![License](https://img.shields.io/github/license/sinemacula/foundation-ts.svg)](LICENSE)

</div>

`@sinemacula/foundation` is the platform-agnostic core of the Sine Macula application kernels: configuration, HTTP,
sessions, queries, realtime, storage and the rest of the shared client logic, as small port-driven TypeScript units
with no framework, DOM or Node-only dependencies.

## How It Works

Applications do not consume this package directly. Each platform kernel (web, mobile) boots the foundation core, binds
its generic contracts to the platform's router and UI, and layers its own services on top. Everything
platform-specific arrives through a port.

| Area                 | What it provides                                                                                                   | Port / contract           |
|----------------------|--------------------------------------------------------------------------------------------------------------------|---------------------------|
| `src/analytics/`     | Records product events through a swappable tracker (console + no-op adapters), plus route page tracking            | `AnalyticsTracker`        |
| `src/app/`           | The boot core: `bootFoundationCore` runs the agnostic phases, plus the service registry and base wiring            | `bootFoundationCore`      |
| `src/authorization/` | Evaluates flat permission grants with wildcard-prefix matching                                                     | `PermissionSet` (no port) |
| `src/config/`        | Reads typed configuration from environment sources, fetches the runtime document and freezes the repository        | `EnvironmentSource`       |
| `src/connectivity/`  | The connectivity-observation contract each platform adapts                                                         | `ConnectivityMonitor`     |
| `src/feature-flags/` | Resolves feature flags through a swappable provider (static adapter included)                                      | `FeatureFlags`            |
| `src/http/`          | HTTP client: a fetch adapter behind a port, a typed error hierarchy, and bearer-token attach + refresh-and-retry   | `HttpClient`              |
| `src/i18n/`          | Locale detection, persistence and negotiation, free of any rendering library                                       | `LocaleService`           |
| `src/logging/`       | A minimal logging port with console and no-op adapters                                                             | `Logger`                  |
| `src/notifications/` | The toast and confirm-dialog ports each platform's notification services implement                                 | `Toaster` / `Confirmer`   |
| `src/query/`         | Resource queries: the `ApiQuery` builder, a typed filter DSL, envelope mapping and `ResourceClient`                | `ResourceClient`          |
| `src/realtime/`      | Live connections behind a port: a WebSocket adapter plus the exponential-backoff reconnect platform adapters share | `RealtimeConnection`      |
| `src/reporting/`     | Error reporting through a swappable reporter and a breadcrumb trail                                                | `ErrorReporter`           |
| `src/router/`        | The navigation middleware contract and pipeline, generic over each platform's route and location types             | `RouteMiddleware`         |
| `src/session/`       | The session core: lifecycle, refresh outcomes, async persistence and a default auth gateway (body or cookie)       | `SessionApi`              |
| `src/storage/`       | A synchronous key-value storage port with in-memory and key-namespacing adapters                                   | `KeyValueStorage`         |
| `src/support/`       | Shared primitives: service holders, deep freeze and record guards                                                  | -                         |
| `src/theme/`         | Colour-scheme state: preference resolution and the OS-source and applier ports                                     | `ColorSchemeService`      |

## Installation

```bash
npm install @sinemacula/foundation
```

The `exports` map resolves to the compiled `dist/` and the `prepare` script builds it, so a git dependency
(`github:sinemacula/foundation-ts#<ref>`) installs the same output as the registry tarball.

There is no barrel: import each module by its subpath. The `exports` map is the public surface; anything unlisted is
internal.

```ts
import { Environment } from '@sinemacula/foundation/config/environment';
import { MemoryStorage } from '@sinemacula/foundation/storage/memory-storage';
```

## Usage

### Bootstrapping

A kernel boots the core through `@sinemacula/foundation/app/boot-foundation-core`, supplying its storage,
notification and fetch seams. The core runs the runtime environment, configuration, storage, feature flags,
notifications, observability and HTTP client phases in that order, and calls the kernel's module registration before
building the client so modules can contribute interceptors.

```ts
const core = await bootFoundationCore({ ...options, runtime: { url: '/runtime-env.json' } }, { fetchFn });
```

`runtime` is optional; omit it where configuration ships with the build, as on mobile. When set, the document must
load within `timeout` (default 5000 ms). A 404 counts as empty, an invalid `timeout` rejects with a `RangeError`, and
any other failure rejects with a `RuntimeEnvironmentError`. The installed services are then available through
`@sinemacula/foundation/app/services`.

### Querying

`ApiQuery` speaks the `sinemacula/laravel-api-toolkit` query grammar. It is immutable: every call returns a new
query.

```ts
const query = ApiQuery.create()
    .where('status', 'active')
    .orWhere([q => q.where('role', 'admin').where('verified', true), q => q.where('role', 'owner')])
    .whereHas('posts', q => q.where('published', true))
    .search('ada')
    .orderBy('name')
    .limit(25)
    .fieldsFor('user', ['id', 'name', 'aggregates'])
    .aggregatesFor('user', ['posts_count']);
// filters={"status":"active","$or":[{"role":"admin","verified":true},{"role":"owner"}],
//          "$has":{"posts":{"published":true}}}&search=ada&order=name&limit=25
//          &fields[user]=id,name,aggregates&aggregates[user]=posts_count
```

- Filter calls AND together and never replace or widen an earlier condition: a different value for a field, a
  colliding operator or a second `orWhere` group is ANDed beside the first under `$and`. Rebuild from a base query
  to change a condition.
- `andWhere` / `orWhere` take one builder per document; keys inside a document AND together. An empty group or
  document throws a `QueryError`.
- Repeated `whereRelation` calls on one relation merge into one document, as do repeated `whereHas` calls, so the
  same related row must match all of them. `whereHasNot` conditions never merge.
- Free-text search is the `search` parameter (`search(term)`), never a filter operator.
- Aggregates render under the record's `aggregates` field only when `aggregates` is in `fields[type]` or the
  resource's default fields.
- `withTrashed()` / `onlyTrashed()` set `trashed=with` / `trashed=only`.
- Changing the filters, search, soft-delete visibility or order drops any cursor token but keeps cursor pagination;
  `limit` and `page` keep it. Random order under cursor pagination throws.
- `fieldsFor(type, [])` requests only the fixed fields and `aggregatesFor(type, [])` suppresses the default
  aggregates.
- `$`-prefixed field or relation names, non-finite numbers, blank field or aggregate names, and a page or limit that
  is not a positive integer throw a `QueryError`.
- `ResourceClient` percent-encodes each `/`-separated id segment and rejects an id with an empty, `.` or `..` segment
  before sending a request.
- `ResourceClient.list` returns the mapped `items`, `meta` (`{ mode: 'length-aware', total, count, hasMore }`,
  `{ mode: 'cursor', hasMore }`, or `null`), the pagination `links`, and `nextCursor` / `prevCursor` read from them.

The toolkit enforces cost caps server-side and answers a request over one with a 422. The defaults are: `limit` 100,
3 order keys, 5 aggregates, an offset of 500000 rows, 500 `$in` items, 100 filter nodes, a filter depth of 3, and
8192 bytes of encoded filters.

### Realtime

`WebSocketConnection` (`realtime/web-socket-connection`) reconnects with exponential backoff after any close it did not
initiate; `disconnect()` stops it until the next `connect()`. `beforeReconnect` skips an attempt when it resolves
`false` or rejects:

```ts
const connection = new WebSocketConnection({
    url: () => `wss://example.test/realtime?token=${readAccessToken()}`,
    beforeReconnect: async () => (await coordinator.refresh()).kind === 'refreshed',
    onError: error => reporter.captureError(error),
});

connection.on('order.updated', message => applyOrderUpdate(JSON.parse(message.data)));
connection.connect();
```

`on('message')` receives every text frame; a `{ event, data }` envelope also reaches that event's subscribers, with a
non-string `data` re-serialised as JSON. `onError` receives failures the connection contains (a throwing subscriber,
`url()` builder or socket factory); the same failure inside `connect()` throws a `RealtimeError` with the original as
its `cause`.

### React Native

Every subpath resolves under Metro and Jest through the `default` export condition, and CI loads the whole public
surface under Metro, Hermes and React Native's Jest preset. The package ships ES modules, so add it to Jest's
`transformIgnorePatterns` allow-list. `KeyValueStorage` is synchronous, so back it with a synchronous store; an
asynchronous secure store implements `SessionPersistence` directly.

## Requirements

- Node.js 22+
- Vitest 3+, only for the realtime contract suite in `realtime/test-support`

## Testing

```bash
npm test                    # unit suite
npm run test:coverage       # unit suite with 100% coverage enforced
npm run test:mutation       # Stryker mutation gate (break 95)
npm run typecheck           # type-check
npm run check               # static analysis and lint via qlty
npm run fmt                 # format via qlty
npm run smells              # duplication / complexity smells via qlty
npm run deadcode            # dead-code detection via knip
npm run check:pkg           # publint + attw on the packed tarball
npm run smoke:react-native  # load every subpath under Metro, Hermes and Jest
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a list of notable changes.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on branching, commits, code
quality, and pull requests.

## Security

If you discover a security vulnerability, please report it responsibly. See [SECURITY.md](SECURITY.md) for the
disclosure policy and contact details.

## License

Licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0).
