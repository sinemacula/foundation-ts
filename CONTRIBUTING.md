# Contributing

Contributions are welcome via GitHub pull requests. This guide covers the expectations for working on this package.

## Requirements

- Node.js 22+
- npm

## Getting Started

```bash
git clone git@github.com:sinemacula/foundation-ts.git
cd foundation-ts
npm install
```

## Development Workflow

### Branching

Branch from `master` using the appropriate prefix:

| Prefix      | Purpose                          |
|-------------|----------------------------------|
| `feat/`     | New functionality                |
| `fix/`      | Bug fixes                        |
| `refactor/` | Refactoring without new features |
| `docs/`     | Documentation                    |
| `chore/`    | Tooling, CI, dependencies        |

### Commits

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Prefix your commit messages accordingly:

```text
feat(session): lift the session lifecycle into a platform-agnostic core
fix(realtime): cancel the reconnect timer on disconnect
test(http): cover the retry policy boundary cases
chore: update qlty configuration
```

### Code Quality

All code must pass static analysis before submission:

```bash
npm run check    # Static analysis and lint checks via qlty (Biome, ESLint)
npm run fmt      # Format the codebase via qlty
npm run smells   # Advisory code smells (duplication, complexity)
```

Run everything through qlty rather than invoking the underlying tools directly; the shared configuration lives in
`.qlty/` and is enforced by Qlty Cloud on every pull request.

### Testing

Run the full suite before submitting:

```bash
npm run typecheck        # Type-check with tsc
npm run test:coverage    # Unit tests, with 100% coverage enforced
npm run deadcode         # Dead-code detection with knip
npm run build            # Production build
npm run check:pkg        # Packaging checks (publint + attw) on the built tarball
```

Single test file or test:

```bash
npx vitest run src/session/session-core.test.ts
npx vitest run -t "shares one request across concurrent rehydrations"
```

### Standards

- The package stays platform-agnostic: no framework, DOM or node-only dependencies anywhere in `src/`. Every
  platform seam (fetch, storage, sockets, notifications) arrives as an injected port, and adapters stay behind
  ports-and-adapters at the edges.
- No barrel files; consumers import by subpath (e.g. `@sinemacula/foundation/http/http-client`). The manifest
  `exports` map is the public-surface allow-list - anything unlisted is internal.
- Wire-format keys (snake_case) never appear as object-literal keys; build records through entry tuples.
- New code ships with colocated tests; the 100% coverage thresholds and the mutation-testing gate
  (`npm run test:mutation`) are the enforced floors.

## Pull Requests

- Keep changes minimal and scoped to a single concern
- Do not change static analysis or formatting configuration without prior discussion
- Include tests for new or changed behaviour
- Ensure `npm run check` and `npm run test:coverage` pass

## Security

If you discover a security vulnerability, please report it directly to Sine Macula rather than opening a public issue.
See [SECURITY.md](SECURITY.md) for details.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
