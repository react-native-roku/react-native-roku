# Build an independent Roku app

Use Node 24.18.1 and pnpm 11.23.0. The tested cohort is React 19.2.8,
reconciler 0.33.0, Yoga 1.10.0 and Roku SDK 2.19.1. The package ships
TypeScript source and public build adapters and requires only its declared dependencies.

## Create and run

With the published preview, create a project directly from the registry.

```sh
npx --yes react-native-roku@latest init my-roku-app
cd my-roku-app
pnpm install
pnpm run doctor
pnpm typecheck
pnpm dev
```

### Test a specific archive

To verify the exact package used in a release, download the developer-preview archive into an empty
directory. Compare its SHA-256 with the release record, then use the same steps
as for an archive supplied for review.

```sh
npm pack react-native-roku@latest
```

Set `archive` to the absolute path of that file:

```sh
archive=/absolute/path/to/react-native-roku-0.2.0-preview.2.tgz
shasum -a 256 "$archive"
scratch=$(mktemp -d)
tar -xzf "$archive" -C "$scratch"
node "$scratch/package/bin/react-native-roku.mjs" init "$scratch/my-roku-app" --package="file:$archive"
cd "$scratch/my-roku-app"
pnpm install
pnpm run doctor
pnpm typecheck
pnpm dev
# Stop the preview before running the finite SDK build.
pnpm build
```

The generator refuses an existing destination. It does not install dependencies,
commit, publish or deploy. Its template has a normal default-exported React
component in `src/App.tsx`:

```tsx
import { View, Text } from "react-native";
export default function App() {
  return (
    <View>
      <Text>Hello Roku</Text>
    </View>
  );
}
```

`roku.config.json` owns the entry, application name, background and font assets:

```json
{
  "name": "HelloRoku",
  "entry": "src/App.tsx",
  "background": "#101014"
}
```

The default font is Inter from the template's pinned `@expo-google-fonts/inter`
dependency. To override it, configure `fonts.defaultFamily` and a `fonts.assets`
map from physical face names to local paths or resolvable package asset paths.
The starter declares a logical `Inter` family with regular (400) and bold (700)
faces. Ordinary `Text` can use `fontWeight: "bold"` or `"700"` without selecting
an asset itself. Custom fonts declare `fonts.families`, for example
`{ "Body": { "normal": { "400": "BodyRegular", "700": "BodyBold" } } }`,
where both physical names exist in `fonts.assets`; set `defaultFamily: "Body"`.
Declare real italic files under `italic` in the same map. Missing requested
weights/styles fail explicitly; the host does not synthesize faces.
The starter also configures `fonts.variants: ["tabular-nums"]` and shows equal-width
digits. This prepares the font's real OpenType tabular face; it does not assume
a native font-feature field. Custom fonts must contain the admitted static
single-glyph `tnum` profile. Remove the variant example/configuration when your
app does not use it; an unconfigured or unsupported requested variant fails
explicitly. Custom pipelines can call `prepareRokuFontAssets` from the public
`build/project` export and register its returned ordinary/variant asset map and
`families` declaration. Custom SDK entry generation accepts `fontFamilies`.
Optional `viewport` defaults to 1920×1080 and `dev.port` defaults to 9389.
Application names must be identifiers containing letters, digits or underscores.

The browser Canvas host watches source and config and serializes/coalesces builds.
The default esbuild frontend reloads after a completed successful build. An error overlay retains the
last good app until the error is fixed. Configuration files remain watched after
atomic editor replacements. `ROKU_DEV_PORT` overrides the port. This is a full
page reload: React state and in-memory credentials reset. Apps may explicitly
use preview-owned `sessionStorage` for their own development credentials; the
platform does not copy credentials from another app. Native rendering, video,
focus observations and performance still need device qualification.

```sh
pnpm build
```

This finite official SDK build writes `dist/roku-app.zip` and a generated native
project in `.roku/`. Those paths are disposable. Do not edit generated Scene,
Main, anchor or native helper files. No command installs a channel or accesses
a device account. Retain the font dependency's redistribution license.

Finite builds default to the `production` React profile (`__DEV__` false and
`NODE_ENV` production). The development preview defaults to `development`.
Choose explicitly with `pnpm build --profile=development` or
`pnpm dev --profile=production`. Development SDK output uses `.roku/development/`
and `dist/roku-app-development.zip`; it cannot overwrite the default candidate.
Each SDK ZIP includes `build-profile.json`. SDK diagnostic/source-map output
remains enabled in both profiles; the profile selects React/application code.
Channel identity, device qualification and publication are separate decisions.

Custom consumers use `rokuBuildProfile(name)` from
`react-native-roku/build/environment` for the same validated immutable
`defines` object. Include the profile in consumer fingerprints and transform
cache keys, and use its `development` boolean when configuring Babel callers.

## Sideload and debug on a Roku

The benchmarked device is a Roku Ultra 4850X running Roku OS 16.0.4 build 853
with Roku SDK 2.19.1. Use a Roku with RSG 2.0 developer support on the same
local network as your computer. [Roku developer-mode setup](https://developer.roku.com/dev/docs/developer-setup)

1. Enable the Development Application Installer on the device and record its
   local URL. After the reboot, open that URL and sign in as `rokudev` with the
   password you set on the Roku.
2. Save the ZIP of any development channel you need to restore. The device
   has one sideload slot. Upload `dist/roku-app.zip` and choose ZIP for a
   checksum-comparable installation. Save the ZIP's SHA-256 and the installer
   checksum and byte count with your test notes.
3. After launch, press Select on the focused counter and confirm it increments
   once. For a navigation example with images and virtualized rows, set
   `entry` to `src/Catalog.tsx` in the generated app and build again.
4. For device debugging, run `pnpm build --profile=development` and sideload
   `dist/roku-app-development.zip`. Read the developer console at port 8085.
   To map a saved JavaScript stack to its source, keep the bundle from that
   exact build and run this command. [Roku SDK runtime and debugging guide](https://developer.roku.com/dev/docs/rsg-sdk-standing-docs-runtime-and-debugging-rk)

   ```sh
   pnpm exec rk decode-stack --build-dir .roku/development/dist/sdk/bundle --file roku-console.log
   ```

| Symptom                                                   | First check                                                                                                                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Doctor reports missing Roku SDK tooling                   | In the generated app, run `pnpm install` through your configured npm registry and rerun `pnpm run doctor`. The template declares the exact SDK cohort.                                        |
| Installer URL fails or the login is rejected              | Open the URL displayed by the device after developer-mode setup and reboot. Use the device-local `rokudev` account and the password you set for it.                                           |
| Remote automation receives 403 or cannot inspect the tree | Confirm developer mode and enable Control by mobile apps under the Roku's advanced system settings. [Roku ECP command requirements](https://developer.roku.com/dev/docs/external-control-api) |
| Font preparation reports a missing face                   | Check the physical face name and asset path in `fonts.assets`, then map the requested weight and style in `fonts.families`. Run `pnpm run doctor` and rebuild.                                |
| Bundling reports an unsupported import                    | Use a public React Native entry point and compare the imported API with the [compatibility matrix](compatibility.md). Keep SDK imports in native host code.                                   |

## React Compiler for esbuild

For React 19 applications, set `"reactCompiler": true` in `roku.config.json` to
compile application modules under the consumer directory. Install the compiler
in that consumer using the tested versions.

```sh
pnpm add -D --save-exact @babel/core@7.29.7 babel-plugin-react-compiler@1.0.0
```

This option applies to the esbuild preview and device builds. For Metro, enable
the plugin through the application's Babel configuration.

Production SDK builds can also reuse equivalent React Native `Text` elements
with scalar children and inline scalar styles. The compiler checks the imported
component and JSX shape before applying this reuse. It preserves evaluation of
the current style and child expressions and honors `"use no memo"`.

## Register an existing React application

An app can use a familiar registration entry instead of a default export:

```tsx
import { AppRegistry } from "react-native";
import App from "./App";
AppRegistry.registerComponent("HelloRoku", () => App);
```

Set `entry` to that file and `entryMode` to `registry`. Its registration key must
match `name`. The host binds its environment before loading the entry, mounts
the registered tree, and owns input/root disposal. This is a registration subset
of AppRegistry; it does not implement every upstream AppRegistry operation.

For an archive upgrade in an existing app, save the current dependency
manifest and lockfile, then run `pnpm add "react-native-roku@file:/absolute/path/to/candidate.tgz"`.
Run doctor, typecheck, preview and a production build again. Keep the prior ZIP
and lockfile available for rollback. To roll back, restore the saved manifest
and lockfile, run `pnpm install --frozen-lockfile`, then replace the sideloaded
channel with the saved ZIP. Confirm its installer checksum and launch state.
Track remote focus with a new observation after a list or route remount before
sending an automated Select.

The standalone catalogue fixture uses `react-native-safe-area-context` 5.8.1
with `SafeAreaProvider` and `useSafeAreaInsets`. See the
[compatibility registry](../compatibility/registry.json) for exact tested
combinations and outstanding execution environments.

### Report a preview issue

Start with the smallest shared JSX that reproduces the behavior in a fresh
generated app. Include the dependency pins, archive SHA-256, minimal
`roku.config.json`, the production ZIP SHA-256, exact steps and expected
result. For a Roku result, include the model, firmware including build, and
whether you observed a native frame, app-tree focus or only key acknowledgement.
Attach a cropped screenshot or a short event trace when available. Remove
appliance addresses, account identifiers, credentials and private media from
reports. Keep original device logs locally.

## Audio

Import `SceneGraphAudio` and `SceneGraphAudioRef` from `react-native-roku/media`
for a nonvisual audio resource. Supply an explicit stream format (`mp3`, `mp4`,
`flac`, `hls` or `es.aac-adts`), rather than inferring it from an opaque URL.
Use its observations for state, position, duration and decoder format. Its ref
supports seek, pause, resume, stop and mute; a submitted command is not playback
evidence. Queues, admission, progress persistence and source-time mapping belong
to the application. Playback speed and fractional volume need additional output
mechanics. See the [compatibility boundary](compatibility.md#audio-resource).

## Existing build pipelines and Metro

React code can extend `react-native-roku/tsconfig`. The public
`rokuPlugin({root})` from `react-native-roku/build/esbuild` supplies adapter
aliases, a single React resolution, `.roku` then `.tv` then shared source
selection, pinned NativeWind corrections and Hermes-safe Yoga preparation.
Unsupported private React Native imports and SDK imports in frontend code fail
explicitly. Upstream React Native types alone do not prove implementation support.

An existing Metro configuration can use:

```js
const { withRoku } = require("react-native-roku/metro");
module.exports = withRoku(existingConfig);
```

Only the `roku` platform gets these aliases/source variants. Other targets keep
the existing resolver. The resolver also selects the reviewed portable
NativeWind engine's native-style leaves on Roku. To prepare its component and
preference adapters and Yoga's finite bindings for Hermes, compose your Babel
transformer in a `roku-transformer.cjs` file:

```js
const { withRokuBabelTransformer } = require("react-native-roku/metro");
module.exports = withRokuBabelTransformer(require("@react-native/metro-babel-transformer"), {
  root: __dirname,
});
```

Set `transformer.babelTransformerPath` in your Metro config to
`require.resolve("./roku-transformer.cjs")`. Keep your existing Babel presets,
plugins and upstream transformer. The wrapper only prepares Roku dependency
source; it preserves the upstream arguments, results, errors and additional
exports. Other platforms pass through unchanged. Its cache key includes the
upstream key, installed platform implementation and Yoga preparation inputs.
A custom upstream's `getCacheKey` must cover its own configuration/dependencies.
No Metro or Babel dependency is required by the ordinary CLI/esbuild workflow.

The optional reviewed tool versions live in `config/toolchain.json` under
`optionalPackages.metro`. `pnpm test:metro` in the platform repository installs
an independent archived-package consumer and checks cold production/development
Metro output and SDK integration. Set `ROKU_HERMES_EXECUTABLE` to also execute
that output in a local host Hermes CLI. Reports retain generated source, runners,
source maps, SDK programs and ZIPs under `.local/metro-consumer-*` (or
`ROKU_QUALIFY_EVIDENCE_DIR`). Host-Hermes execution links the partitioned frontend
with esbuild for the VM; SDK builds consume the separate bounded modules.

For an independent Metro application, initialize with:

```sh
react-native-roku init ../my-metro-app --package=file:/absolute/platform.tgz --bundler=metro
cd ../my-metro-app
pnpm install
pnpm run doctor
pnpm typecheck
pnpm build
pnpm dev
```

The generator sets `bundler: "metro"` in `roku.config.json` and adds the optional
cohort and Babel preset. An existing app can add that field and the same tool
cohort to its dev dependencies. The CLI loads its Metro config, composes the
Roku resolver/transformer and preserves its Babel policy. Component and registry
entry modes, fonts, production/development profiles and SDK ZIP paths use the
same project builder. The SDK stage still compiles native mechanics separately.
Metro/Babel config and package manifest edits trigger full preview reloads.

Custom build systems call `buildRokuMetroModules` from `/build/frontend` with
`root`, `entry`, `outfile`, optional `profile`, `configPath` or `configuration`,
and the entry's named `exports` (default `mountApplication`). It prepares full
collation data before Metro scans files, using the same bounded static data
extractor as esbuild. It then writes ESM modules with one Metro require cache,
source maps and a default 2 MiB code limit per module. An oversized module or an
unreviewed serializer shape fails explicitly. Its returned files/hashes and
`frontend.json` are build inputs for a consumer's existing artifact policy.
The returned `metafile` attributes each source factory to its actual output
chunk and records dependency edges. `assets` contains Metro's complete asset
descriptors, including density variants and configured asset-plugin metadata,
on both cold builds and transform-cache hits. Set
`imageAssets: { generatedDirectory: "/owned/output/images" }` to use the
package's raster compiler and registry. This composes configured asset plugins,
preserves their metadata, and restores physical images on cache hits using the
complete density inventory and Metro's exact source snapshots. Embedded literals
become separate static modules before a second file-map scan, preserving their
values without exceeding the module budget. Preparation stops when the graph
settles and refuses changed source snapshots; `imagePreparationPasses` records
the finite pass count. Omitting this
option retains a custom host's existing asset registry.
The frontend retains its selected `NODE_ENV` independently of the host's
environment; an explicit development profile cannot inherit production mode.
Use a generation-owned output/work directory; caller lifetime policy retires
old generations. The raw Metro bundle and map remain in the work directory.

Metro development previews preserve React state across safe component edits.
Changing a hook signature resets that component. A changed dependency graph,
configuration, runtime, asset/font or module resource lifetime requests a full
page reload. Syntax/build failures retain the last good application; corrected
component edits can resume stateful updates. Module and render failures are
reported through the preview without creating a second Metro runtime.
Production-profile previews and the default esbuild frontend retain full reload.
Finite SDK builds and device package reload do not provide native stateful hot
reload. Native behavior and performance have separate qualification gates.

Custom preview systems can use `createRokuProjectDevServer` from
`react-native-roku/build/project` with `root`, optional `profile`, `port` and
`onBuild`; call its asynchronous `close()` to retire watchers and its owned
workspace. Lower-level integrations use `createRokuMetroRefreshSession` and
`writeRokuRefreshBootstrap` from `/build/frontend`. Keep one session and stable
entry/generated paths across builds, pass `{session,generation}` as `refresh`
to `buildRokuMetroModules`, and put the generated bootstrap before loading the
application. Stage the returned `refreshGraph` with an identity covering all
configuration, runtime, image and font bytes. Return its plan to
`createRokuDevServer` from `/build/dev`; publish the session only when that
generation is published, discard abandoned generations and dispose on close.
Configuration changes must never be represented as safe component updates.

The repository's `pnpm test:metro-development` separately qualifies the generated
Metro app's browser development loop through the same font/edit/error/fix/session
and activation journey as the default frontend. `pnpm check` and exact-archive
candidate qualification include the Metro build/reload lanes and a separate
`pnpm test:fast-refresh` installed-consumer browser journey locally.

For custom hosts, `createRokuHost` from `/sdk-host` owns SDK mechanics;
`mountRegisteredApplication` from `/application` mounts a registered React app.
React-side port types come from `/host` without SDK/Solid JSX types.
`generateSdkEntry`, `createRokuSdkConfiguration`, `readRokuConfig` and
`resolveProjectFont` from `/build/project` allow an existing canonical build to
generate the same native mechanics. A custom mount pipeline can use entryMode
`mount`; the default CLI app builder requires `component` or `registry`.
`prepareNativeComponents` from `/build` copies generic helpers into a generated
tree. SDK compilation remains separate from the React frontend typecheck.

Applications own routes, providers, queries, assets and product focus topology.
The host owns native lifecycle, key transport, fonts/raster setup, native service
adapters, retirement and exit requests. A stable `storageNamespace` keeps native
application storage separate. Never edit installed dependency sources.

### Custom application lifetime

Custom launchers use `mountApplication` from `/application`, the same lifetime
owner used by `mountRegisteredApplication`. Content is created lazily after the
root/input and optional portable web runtime are bound:

```tsx
import { mountApplication } from "react-native-roku/application";
const app = mountApplication(context, {
  webRuntime: "host", // an explicit host fetch policy; default is portable
  setup() {
    const unsubscribe = subscribeApplicationFacts();
    return unsubscribe;
  },
  createContent() {
    const session = createApplicationSession();
    return { element: <App session={session} />, dispose: () => session.close() };
  },
});
try {
  await app.whenCommitted();
} finally {
  await app.dispose();
}
```

`context` contains `scene` and the public native-root options, plus an optional
`webTransport`. The lifetime allocates its own input; `app.input` permits host
diagnostics but must not be disposed by the consumer. `remote` and
`publishSystem` stop admitting calls as soon as disposal begins. The root
and setup subscriptions retire synchronously; disposal awaits the content
callback, then releases the web leases. Resources needed by asynchronous content
cleanup belong to that content's disposer. Repeated/reentrant calls return the same promise. Every
independent cleanup is attempted and the first cleanup error rejects that
promise. A setup/content/render error remains the original synchronous error,
with any asynchronous cleanup rejection observed internally. A throwing setup
or content factory owns its own partially constructed resources until it
returns them. Handle asynchronous commit failures and dispose in `finally`.

The root owns the supplied text/raster providers after successful allocation;
allocation failure leaves those providers with the caller. Timer compatibility
is an idempotent process bootstrap, not a per-root clock lease. Overlapping
roots require the same viewport, system and device-services ports. Web leases
can retire out of order; an older async cleanup cannot clear a newer host's
globals or resurrect a retired installation. Consumer setup still owns any
additional global policy and must honor its own overlap requirements.

`examples/minimal/src/applicationOwnership.ts` is an executable packed-consumer
example with input, asynchronous disposal and original-error cleanup controls.
Run `pnpm test:consumer` in the producer to install and execute it outside the
producer checkout. It uses only public package imports and its own fixture
identities.

NativeWind className compilation still needs the app's Tailwind/CSS and Babel
configuration; aliasing alone does not compile CSS. Expo, navigation, SVG,
animation and storage integrations implement documented subsets. See the
[compatibility contract](compatibility.md).

## Static images

The default project builders package static PNG/JPEG imports and convert WebP
to PNG. SDK builds import the prepared files; the browser preview serves those
same bytes under `/assets/`. Metro selects the first density at least as large
as the target scale, or the largest available variant, while preserving logical
width/height. The current logical-pixel host targets scale 1. Custom builds may
set `imageAssets.scale` explicitly; this is build-time selection, not adaptive
device-density switching.

Static PNG/JPEG/WebP data URI literals retain their exact authored values,
including schema-validated strings and JSX attributes. A generated registration
maps them to packaged images at the image adapter. Comments and URI-prefix
checks are untouched. Animated images and other embedded formats fail explicitly.
Host preparation and browser rendering do not establish native bitmap fidelity.

Custom build systems import `createRokuImageAssets` from
`react-native-roku/build/assets`. Its `packageImage` and `prepareEmbeddedSource`
methods compose with application-owned Babel transforms. `metroConfiguration`
provides the asset plugin/registry, `restoreMetroAssets` rematerializes a complete
Metro inventory, and `writeSdkModule` emits SDK imports for the used images.
`inventory` returns a deterministic, content-addressed file map. The optional
`esbuildPlugin` handles raster imports and embedded literals in standalone builds;
an existing Babel owner calls the preparation method before its own transform.
Use an owned output generation and retire it through your existing build policy.
`prepareEmbeddedSource` returns references to generated modules; prepare these
before starting a custom Metro file map. The public Metro frontend owns that
sequence automatically. Its optional inline mode retains literals in one module
and is suitable only when the caller separately enforces its module budget.
The compiler loads the reviewed SDK tooling's `sharp` dependency when needed.

## Qualification

`pnpm check` in the platform repository runs both type boundaries, host/build
contracts, package hygiene, independent packed React and SDK consumers, and a
fresh-profile headless Chromium edit/reload/error/fix/activation journey. Set
`ROKU_TEST_CHROMIUM` if Chrome/Chromium is not in a standard location. Evidence
is saved under `.local/`. These checks prove the packaged development path;
firmware behavior and device performance remain unqualified.
