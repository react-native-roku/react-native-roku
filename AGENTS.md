# react-native-roku

Read `docs/maintenance.md` for setup, checks, compatibility, update and release
ownership. `docs/getting-started.md` owns consumer setup; `docs/compatibility.md`
owns the experimental support boundary.
See `docs/qualification.md` for sealed or individually executed package lanes.

- Keep this package application-independent. Product routes, data/query policy,
  server contracts and semantic focus topology belong to consumers.
- Keep React frontend code separate from SDK/Solid compilation. Native mechanics
  publish observations; do not fabricate playback, focus or device evidence.
- `compatibility/registry.json` owns adapter aliases and reviewed API surfaces.
  Public export classifications and coordinated toolchain versions are checked.
- Update source/config generators, never generated `.roku`, `dist` or installed
  dependency files. Qualify the actual packed bytes in independent consumers.
- Run `pnpm check:fast` while iterating and `pnpm check` for a candidate. Device
  behavior remains pending until separately source/artifact-attested.
- The developer preview uses MIT. Repository visibility, release tags, pushes
  and npm staging or publication require the owner's direction.

Use [standalone testing](docs/standalone-testing.md) for package-owned benchmarks,
profiling and device lifecycle. Keep fixtures and lab configuration reproducible
from one checkout and public tooling.
