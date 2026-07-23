# @sinemacula/foundation

Platform-agnostic TypeScript foundation: the framework-free ports and logic
(http, config, storage, query, realtime, session, authorization, logging,
i18n, notifications, theme) shared by Sine Macula's web and mobile kernels.

## Installation

```bash
npm install @sinemacula/foundation
```

## Usage

The package has no barrel: every module is imported by its explicit subpath,
and the `exports` map is the public-surface allow-list.

```ts
import { Environment } from '@sinemacula/foundation/config/environment';
import { MemoryStorage } from '@sinemacula/foundation/storage/memory-storage';
```

Platform kernels boot the core through
`@sinemacula/foundation/app/boot-foundation-core`, supplying their own storage,
notification and fetch seams; applications normally consume this package
through a kernel rather than directly.

## License

Apache-2.0
