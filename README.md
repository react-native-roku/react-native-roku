# react-native-roku

Experimental, source-distributed React Native-compatible host for Roku SceneGraph
(RSG 2.0 / Roku SDK 2.19.1). It renders React 19.2.8 through a custom reconciler,
Yoga layout, native text metrics, and explicit platform adapters. It is not a
complete React Native implementation.

## Create your first Roku app

Use Node 24.18.1 and pnpm 11.23.0. The default npm release includes previews. The starter includes a counter and a virtualized catalog you can navigate with a remote.

```sh
npx --yes react-native-roku@latest init my-roku-app
cd my-roku-app
pnpm install
pnpm run doctor
pnpm dev
```

Edit `src/App.tsx` in the browser preview. Stop the preview and run `pnpm build` to create `dist/roku-app.zip` for a Roku in developer mode. Follow the [device setup and sideload guide](docs/getting-started.md).

## What the preview supports

The [compatibility matrix](docs/compatibility.md) lists supported React Native APIs and platform differences. Physical navigation testing covers the Roku Ultra 4850X. Performance on lower-tier hardware, long-session memory behavior, and spoken screen-reader output need further testing.

The public `rokuPlugin` from `react-native-roku/build/esbuild` owns platform
resolution and pinned compatibility transforms. React code can extend
`react-native-roku/tsconfig`; SDK code uses `createRokuHost` from
`react-native-roku/sdk-host`. A normal app supplies `src/App.tsx` and `roku.config.json`. The CLI generates
SDK anchors, Scene/Main files and native helpers under `.roku/`; application
code keeps ordinary React and supported `react-native` imports. Advanced
consumers can retain their existing build pipeline through the public host and
configuration helpers.

Use `pnpm dev` for the Canvas watch/reload preview, `pnpm run doctor` for readiness,
and `pnpm build` for a finite SDK ZIP build. This development loop reloads the
page after successful compilation; it does not preserve React state through
Fast Refresh. `react-native-roku/metro` also supplies a target-scoped resolver
adapter for existing Metro configurations. The separate Metro lanes cover
packaged builds, browser reload and browser Fast Refresh. Native device
updates require another build and sideload.

## Develop

Use Node 24.18.1 and pnpm 11.23.0:

```sh
pnpm setup:repo
pnpm check:fast
pnpm check
```

`pnpm check` runs both TypeScript boundaries, runtime/build tests, package hygiene,
and an independent consumer installed from the actual tarball. The consumer runs
outside this repository and imports only public exports.

`pnpm check` includes both packed consumers, the official SDK build and a real
headless-browser edit/error/recovery loop. The
complete example's source has no imports from a consuming application.
See [compatibility](docs/compatibility.md) and [contribution guidance](CONTRIBUTING.md)
for the bounded support contract and release gates.

See [maintenance](docs/maintenance.md) for the executable compatibility register,
CI, packed consumer updates, development cleanup, device capture and
release preparation. This developer preview uses the [MIT License](LICENSE).

See the [standalone test guide](docs/standalone-testing.md) for device setup and coverage. The [full-title Solid benchmark and measured Ultra example](https://github.com/react-native-roku/react-native-roku/blob/HEAD/benchmarks/navigation/README.md#reproduce-the-full-title-solid-scorecard) include matched inputs, per-launch tails and same-build variation.
