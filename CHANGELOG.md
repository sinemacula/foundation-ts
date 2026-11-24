# Changelog

## [0.3.0](https://github.com/sinemacula/foundation-ts/compare/v0.2.0...v0.3.0) (2026-11-24)


### Features

* **session:** tell a refresh without its cookie apart from a refused credential ([#70](https://github.com/sinemacula/foundation-ts/issues/70)) ([ddad7c3](https://github.com/sinemacula/foundation-ts/commit/ddad7c37ea89c9da0d4f70497fa6e92650bd2fde))

## [0.2.0](https://github.com/sinemacula/foundation-ts/compare/v0.1.0...v0.2.0) (2026-11-23)


### Features

* **connectivity:** confirm offline and recovery with reachability probes ([#65](https://github.com/sinemacula/foundation-ts/issues/65)) ([8f05fbd](https://github.com/sinemacula/foundation-ts/commit/8f05fbd547c85872d1e00b179c3bb878d74c7802))

## 0.1.0 (2026-11-17)


### ⚠ BREAKING CHANGES

* hardening follow-ups across http, query, session and app wiring ([#50](https://github.com/sinemacula/foundation-ts/issues/50))
* deliver flag and colour-scheme changes from a snapshot ([#53](https://github.com/sinemacula/foundation-ts/issues/53))
* **realtime:** harden subscribers, reconnect backoff, frames and the realtime contract ([#49](https://github.com/sinemacula/foundation-ts/issues/49))
* **session:** harden redirects, cross-context exchanges and session lineage ([#48](https://github.com/sinemacula/foundation-ts/issues/48))
* **query:** keep filter scopes intact and harden query inputs ([#47](https://github.com/sinemacula/foundation-ts/issues/47))
* harden FetchHttpClient headers, URLs, timeouts, cancellation and 401 handling ([#45](https://github.com/sinemacula/foundation-ts/issues/45))
* align authorization, flags, page tracking and theme with their contracts ([#44](https://github.com/sinemacula/foundation-ts/issues/44))
* harden config typing, freezing, lookups and environment reading ([#43](https://github.com/sinemacula/foundation-ts/issues/43))
* make foundation load cleanly under React Native ([#38](https://github.com/sinemacula/foundation-ts/issues/38))
* sync the foundation with the API toolkit and authentication contracts ([#35](https://github.com/sinemacula/foundation-ts/issues/35))

### Features

* harden config typing, freezing, lookups and environment reading ([#43](https://github.com/sinemacula/foundation-ts/issues/43)) ([0cfe01b](https://github.com/sinemacula/foundation-ts/commit/0cfe01b30db13d2991545b0360f1cac4afcd0d4e))
* make foundation load cleanly under React Native ([#38](https://github.com/sinemacula/foundation-ts/issues/38)) ([c9bcc18](https://github.com/sinemacula/foundation-ts/commit/c9bcc1808957e436627870f2e55b99584109671d))
* **query:** keep filter scopes intact and harden query inputs ([#47](https://github.com/sinemacula/foundation-ts/issues/47)) ([a8370c7](https://github.com/sinemacula/foundation-ts/commit/a8370c764deb9fd9f6434553bf85c47c4f389bb3))
* **realtime:** harden subscribers, reconnect backoff, frames and the realtime contract ([#49](https://github.com/sinemacula/foundation-ts/issues/49)) ([e838b05](https://github.com/sinemacula/foundation-ts/commit/e838b05a37c7e2dae1da87342d9d6e91e6947937))
* **session:** persist the session through an atomic record store ([#52](https://github.com/sinemacula/foundation-ts/issues/52)) ([0b987ba](https://github.com/sinemacula/foundation-ts/commit/0b987ba921ced0bd3e5175fd7528ab89fc1f29a4))
* sync the foundation with the API toolkit and authentication contracts ([#35](https://github.com/sinemacula/foundation-ts/issues/35)) ([d2477ce](https://github.com/sinemacula/foundation-ts/commit/d2477ce18578e41401b91c8fdb16efa452729d89))
* the platform-agnostic foundation, extracted from the web kernel ([#1](https://github.com/sinemacula/foundation-ts/issues/1)) ([f1411da](https://github.com/sinemacula/foundation-ts/commit/f1411dac7c9503749bfeba2a4ecf0d3608100596))


### Bug Fixes

* align authorization, flags, page tracking and theme with their contracts ([#44](https://github.com/sinemacula/foundation-ts/issues/44)) ([647ad6c](https://github.com/sinemacula/foundation-ts/commit/647ad6c5883326e0e8cb2838ba922de6e44a8ccd))
* deliver flag and colour-scheme changes from a snapshot ([#53](https://github.com/sinemacula/foundation-ts/issues/53)) ([b45aa5d](https://github.com/sinemacula/foundation-ts/commit/b45aa5d811fa6d0cb95604646756b4342bb01c25))
* harden FetchHttpClient headers, URLs, timeouts, cancellation and 401 handling ([#45](https://github.com/sinemacula/foundation-ts/issues/45)) ([8382e6e](https://github.com/sinemacula/foundation-ts/commit/8382e6e2f73697d4fbd0ed0733854cbebda26002))
* hardening follow-ups across http, query, session and app wiring ([#50](https://github.com/sinemacula/foundation-ts/issues/50)) ([e9042d9](https://github.com/sinemacula/foundation-ts/commit/e9042d913ce584bc66ea17cf98fade20f5b90af1))
* load the project Biome config under the shared qlty source ([#36](https://github.com/sinemacula/foundation-ts/issues/36)) ([b6da4ea](https://github.com/sinemacula/foundation-ts/commit/b6da4ea3be5a318bd1869c36e0827758a83325a2))
* **session:** harden redirects, cross-context exchanges and session lineage ([#48](https://github.com/sinemacula/foundation-ts/issues/48)) ([8ebecf5](https://github.com/sinemacula/foundation-ts/commit/8ebecf5b927d5db4310c3674e69de3c23b1a1f10))
