# Changelog

## [1.10.0](https://github.com/dackota/resume-website/compare/v1.9.0...v1.10.0) (2026-08-16)


### Features

* add stable per-visitor id to page-view spans ([#47](https://github.com/dackota/resume-website/issues/47)) ([ea374c8](https://github.com/dackota/resume-website/commit/ea374c862f71664068e7a933956986f7225cacde))

## [1.9.0](https://github.com/dackota/resume-website/compare/v1.8.0...v1.9.0) (2026-08-15)


### Features

* link change feed entries to their PRs and repos ([#43](https://github.com/dackota/resume-website/issues/43)) ([ea39dab](https://github.com/dackota/resume-website/commit/ea39dab6b6a75ad9207a8d2254a6145d61cb8589))

## [1.8.0](https://github.com/dackota/resume-website/compare/v1.7.1...v1.8.0) (2026-08-12)


### Features

* export browser spans to Honeycomb over OTLP ([#41](https://github.com/dackota/resume-website/issues/41)) ([8175cdf](https://github.com/dackota/resume-website/commit/8175cdfd9cf79f5f9aaec05ee129de4cdc3a40db))

## [1.7.1](https://github.com/dackota/resume-website/compare/v1.7.0...v1.7.1) (2026-08-05)


### Bug Fixes

* update blog content ([#38](https://github.com/dackota/resume-website/issues/38)) ([5665f8b](https://github.com/dackota/resume-website/commit/5665f8bdcd8269567167359dd2c43f1d4310185e))

## [1.7.0](https://github.com/dackota/resume-website/compare/v1.6.0...v1.7.0) (2026-08-05)


### Features

* rename the post bundle and link the Glasswing sources ([#36](https://github.com/dackota/resume-website/issues/36)) ([5f36ac9](https://github.com/dackota/resume-website/commit/5f36ac9dc3bee10b44134a029095256df2594fe8))

## [1.6.0](https://github.com/dackota/resume-website/compare/v1.5.0...v1.6.0) (2026-08-04)


### Features

* rework the K8s security post intro and voice ([#34](https://github.com/dackota/resume-website/issues/34)) ([2b3b9bf](https://github.com/dackota/resume-website/commit/2b3b9bfeb182e50b83a4a6ab5f85ea33c2252bed))

## [1.5.0](https://github.com/dackota/resume-website/compare/v1.4.0...v1.5.0) (2026-08-04)


### Features

* add Kubernetes post on the twelve Glasswing security rules ([#31](https://github.com/dackota/resume-website/issues/31)) ([aa7ca07](https://github.com/dackota/resume-website/commit/aa7ca079f9d185b9606f41738a869a06525a6340))

## [1.4.0](https://github.com/dackota/resume-website/compare/v1.3.3...v1.4.0) (2026-08-04)


### Features

* add a blog at /blog, trim the resume page, and close out the GAAI role ([#29](https://github.com/dackota/resume-website/issues/29)) ([c0775ed](https://github.com/dackota/resume-website/commit/c0775ede12b54d27b6c991d87c35dcd3e78ec688))

## [1.3.3](https://github.com/dackota/resume-website/compare/v1.3.2...v1.3.3) (2026-08-03)


### Bug Fixes

* **deps:** update nginxinc/nginx-unprivileged:1.31.3-alpine3.24 docker digest to a6c3ec0 ([#25](https://github.com/dackota/resume-website/issues/25)) ([8b34aea](https://github.com/dackota/resume-website/commit/8b34aea0b3c3a89389da06f53e0d8dbf9e79eb16))

## [1.3.2](https://github.com/dackota/resume-website/compare/v1.3.1...v1.3.2) (2026-08-01)


### Bug Fixes

* repalette the github span bar off the red family ([#21](https://github.com/dackota/resume-website/issues/21)) ([11da5b7](https://github.com/dackota/resume-website/commit/11da5b73246758f408e62b8f9459ea574770472f))

## [1.3.1](https://github.com/dackota/resume-website/compare/v1.3.0...v1.3.1) (2026-08-01)


### Bug Fixes

* confine the span waterfall to a fixed viewport ([#19](https://github.com/dackota/resume-website/issues/19)) ([51db2c4](https://github.com/dackota/resume-website/commit/51db2c4252fe0c88606be291e19d2b6849b07599))

## [1.3.0](https://github.com/dackota/resume-website/compare/v1.2.1...v1.3.0) (2026-08-01)


### Features

* blast-radius inspector and impact heatmap with live API filters ([#15](https://github.com/dackota/resume-website/issues/15)) ([7bb54f5](https://github.com/dackota/resume-website/commit/7bb54f5bb5fe3b6f81e4d9ba1aee0596e36ef731))


### Bug Fixes

* freeze the trace clock between spans instead of tracking wall-clock ([#18](https://github.com/dackota/resume-website/issues/18)) ([057ce10](https://github.com/dackota/resume-website/commit/057ce10ee2af35efe502cc65579cef1e233a9f40))

## [1.2.1](https://github.com/dackota/resume-website/compare/v1.2.0...v1.2.1) (2026-08-01)


### Bug Fixes

* version asset URLs so releases can't strand returning visitors ([#14](https://github.com/dackota/resume-website/issues/14)) ([fd48c45](https://github.com/dackota/resume-website/commit/fd48c450246e65dea6e3c6bd270386b47f34abd3))

## [1.2.0](https://github.com/dackota/resume-website/compare/v1.1.0...v1.2.0) (2026-08-01)


### Features

* live change feed from the change-tracking dashboard ([#11](https://github.com/dackota/resume-website/issues/11)) ([9f0694a](https://github.com/dackota/resume-website/commit/9f0694a747c79de60f16e41d6baf5dbfc98cceb5))

## [1.1.0](https://github.com/dackota/resume-website/compare/v1.0.2...v1.1.0) (2026-08-01)


### Features

* instrument the site as a trace, an SLO, and live DORA metrics ([#9](https://github.com/dackota/resume-website/issues/9)) ([7dff506](https://github.com/dackota/resume-website/commit/7dff5064d46e117a5f8afb7b12ffb6b4c6680df0))

## [1.0.2](https://github.com/dackota/resume-website/compare/v1.0.1...v1.0.2) (2026-07-30)


### Bug Fixes

* Update description and blurb for clarity ([#7](https://github.com/dackota/resume-website/issues/7)) ([f456cea](https://github.com/dackota/resume-website/commit/f456cea80d95982085a48a0c1b40f5f4c1c9106d))

## [1.0.1](https://github.com/dackota/resume-website/compare/v1.0.0...v1.0.1) (2026-07-29)


### Bug Fixes

* drop redundant "in practice" from platform-lead promotion copy ([#4](https://github.com/dackota/resume-website/issues/4)) ([63bc87e](https://github.com/dackota/resume-website/commit/63bc87ec49c950301bb90923800289cc2dcf68da))

## 1.0.0 (2026-07-29)


### Features

* interactive platform-console resume site ([2874d26](https://github.com/dackota/resume-website/commit/2874d26c33585bbcf22471fc71be1a124a18558a))
