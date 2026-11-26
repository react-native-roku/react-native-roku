# Contributing and maintaining compatibility

The project uses the [MIT License](LICENSE). See [maintenance](docs/maintenance.md)
for release qualification and the owner approval step.

Use the pinned Node/pnpm versions and run `pnpm check`. That command validates
runtime and SDK types, host/build contracts, package hygiene, an independent
packed React consumer, a complete independent SDK example build, and a fresh
headless-browser edit/reload/error/recovery journey. Set `ROKU_TEST_CHROMIUM`
when Chrome/Chromium is not installed in a standard location. Examples
must not import a larger application's source or depend on its configuration.
Run the public fixtures against the packed package.

A change to a public prop, library adapter or device service should carry a
behavioral contract for the affected API, including cleanup/failure behavior.
Mark unsupported operations explicitly. Keep product routes, data/query policy,
focus topology, server behavior and feature composition out of this package.
Native code owns mechanics; applications own their product decisions.

The public alias manifest owns resolution; the public TypeScript config is
checked against it. Keep generic compatibility transforms in the package's build
plugin. Do not repair consumers by editing installed dependencies or creating
source-tree symlinks. Pinned upstream-source corrections must reject drift.

Treat React/reconciler and SDK versions as coordinated compatibility boundaries.
Before releasing a version, run package qualification and consuming-app tests,
then device qualification for rendering, input/focus, fonts, networking/storage,
video and sustained resource/performance behavior. CLI/Canvas success is not a
device claim. The old upstream Hermes CLI's Intl failure remains an explicit
partial result until the actual target runtime is qualified.

Publish immutable versions from the reviewed public source revision. During local development, consumers
can install content-addressed tarballs. No build/check command commits, pushes,
publishes or installs a channel.
