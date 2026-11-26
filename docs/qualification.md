# Exact-archive qualification

This is maintainer tooling in the producer checkout. Consumer setup remains in
`getting-started.md`.

All lane CLIs use the [bounded storage owner](maintenance.md#qualification-storage).
The owned temporary directory stays fixed across individually executed lanes
for the same archive and evidence root, including prepare/seal steps. Do not
change `RNR_QUALIFICATION_STORAGE_ROOT` mid-cohort. Completed sealed runs retire
their temporary consumers; older archived evidence must be restored before
exact-archive reuse. An interrupted or storage-limited run is not a pass.

The default runner executes all six independent lanes and seals their actual
reports, captured conformance sources and retained artifacts:

```sh
node scripts/qualify-package.mjs --archive=/absolute/runtime.tgz --output=/absolute/fresh-evidence
```

After a lane and its dependents finish, the serial runner retires only its
reinstallable dependency directories. The SDK consumer remains installed until
the browser development lane finishes. Captured installed sources, generated
programs and complete default consumer trees remain and are checked again at
sealing. Retirement requires the live storage owner's namespace, a passed
exact-archive lane proof, no open processes/files and unchanged retained inputs;
`cache-retirement.json` records each operation. This reduces peak allocation
without skipping lanes or relaxing the shared storage policy.

For limited disk capacity, the same owner supports individually executed lanes.
Prepare a fresh directory before the first lane:

```sh
node scripts/qualify-package.mjs --prepare-only --archive=/absolute/runtime.tgz --output=/absolute/fresh-evidence
```

This captures the lane helpers, browser driver and minimal example, records their
inventory and archive identity, and prints the required lane commands. It does
not execute or qualify an application. Keep producer source and helpers fixed
until all lanes finish. Set `ROKU_QUALIFY_ARCHIVE` and
`ROKU_QUALIFY_EVIDENCE_DIR` to those same absolute paths and run the printed
scripts with Node. The development lane uses the SDK lane's real consumer and
must follow it. Run one lane at a time and check its terminal result. Keep both
temporary default consumers until sealing. Both orchestration modes retain their
complete trees without `node_modules`; seal-only compares existing snapshots to
the finished originals and refuses partial or changed copies. Verification
requires retained React source and the compiled SDK program in the sealed inventory.

An explicit `ROKU_HERMES_EXECUTABLE` selects actual host-Hermes execution in the
Metro lane and SDK observer check; an omitted executable does not establish a
Hermes pass. SDK builds
and browser results do not qualify Roku firmware.

The SDK lane also bundles the installed archive's public `sdk-services` export
and executes its actual pinned SDK wrappers in a fresh Node child. It captures
all program inputs and its runner before execution, then checks string storage,
legacy reads, failure/flush recovery, namespaces and randomness binding through
explicitly synthetic native ports. Its retained `sdk-services-*` proof does not
qualify native encryption, durable relaunch, key protection or revocation.

The SDK lane's `sdk-observers-*` check bundles the installed public device-facts
and raster transports. It captures and executes the pinned SDK's actual
`setProperty`, handler-name detection and field-name transformation against
explicit synthetic Tree API field, registration and timer ports. Unadmitted
native operations fail. The check covers handler-unregister cues, replacement
subscriptions, reentrant retirement, failed request timers and cleanup retries.
Node and an explicitly selected Hermes execute the same ES5 program bytes,
lowered with the existing TypeScript compiler. Inputs, primary SDK source,
compiler identity, executable/program hashes and separate execution logs remain
in the SDK evidence. Native task execution and physical cleanup remain pending.

After all required lanes pass:

```sh
node scripts/qualify-package.mjs --seal-only --archive=/absolute/runtime.tgz --output=/absolute/fresh-evidence
```

Sealing refuses missing, failed or mismatched lane reports and changed prepared
sources, captures or example inventories. It records its own finalizer bytes and
the execution mode. It also accepts older independently captured cohorts with
the existing `orchestration-inputs` layout, checking their conformance sources
and identifying that capture mode explicitly. Existing input records retain
their original timing; sealing does not turn a later copy into an earlier one.

Retain the printed `manifestSha256` outside that sealed directory. Reuse requires
that recorded value, every retained byte, all six exact-archive reports and
unchanged conformance sources:

```sh
node scripts/qualify-package.mjs --verify-only --archive=/absolute/runtime.tgz --output=/absolute/sealed-evidence --manifest-sha256=RECORDED_SHA256
```

No operation overwrites a completed cohort. Preserve failed attempts and choose
fresh output for a retry. Regeneratable `node_modules` trees are excluded from
the final inventory; source captures, programs, maps, resources and SDK artifacts
remain. Do not delete a cache if any preserved manifest includes its files.
Recover capacity only after a lane is terminal and retained evidence is verified.
Physical device checks have their own evidence.

A smaller run budget may be selected when retained history leaves less than the
12 GiB default allocation. For example:

```sh
RNR_QUALIFICATION_RUN_LIMIT_GIB=6 node scripts/qualify-package.mjs --archive=/absolute/runtime.tgz --output=/absolute/fresh-evidence
```

This accepts whole GiB values from 1 through 12 and only lowers the allocation
limit; 32 GiB must still be free before launch, the 20 GiB reserve and history cap
remain, and retained output plus the selected budget must fit. All stages and durations still
run. An allocation-limit failure preserves its inputs and never becomes a pass.
The state record exposes the selected limit and peak sampled allocation. Nested
commands reuse the existing owner's allocation and cannot increase it.

### Planning a series of runs

Use the configured storage owner's capacity preview before starting a sequence. Each
stage specifies its maximum allocation in GiB and the additional bytes expected to
remain afterwards in MiB. Include build products, probe evidence, and cleanup scratch.
Use the full stage allocation as carry if the retained size is unknown. Preview reads
one snapshot. Each real stage still acquires the owner lock and checks current space.

    python3 scripts/qualification_capacity.py --store "$STORE" plan --project "$PROJECT" \
      --stage build 4 4096 --stage probe 3 512 --stage cleanup 1 0 --recovery-gib 2

On the 80 GiB store, the maintenance trigger is 72 GiB and the target is 70 GiB.
For cold history, supply a reviewed JSON selection with the canonical store path and
an `archives` array of `identity` and original `sha256` pairs. Only enroll terminal
archives whose consumers can use the indexed restore command. Keep raw ZIPs named
by active workflows, rollback, and preserved checkpoints out of the selection.
Run `qualification_capacity.py --store "$STORE" maintain --selection cold.json --limit 4`.
The owner takes its normal nonblocking lock for one archive at a time. A busy owner
takes precedence. To finish an already-triggered campaign below the trigger, set
`continueToTarget` in its reviewed selection. Each index pins the original ZIP hash
and the manifest for reconstructing it. Preserve all packs, including those shared
by later archives. The ordinary storage restore CLI accepts the original archive path
and hash for packed history. Reports that need a directly readable ZIP should retain
their raw archive path.

To enroll reviewed cold archives for proactive maintenance, place their selection
in `maintenance/cold-archives.json` in the owned store. At the trigger a new guard
may compact one enrolled archive of up to 96 MiB before normal admission. After
updating the runner, a physical probe automatically goes through this same path.
The separate maintenance command handles larger archives and catch-up batches.

On macOS, `python3 scripts/qualification_cache_macos.py --store "$STORE" --limit 32`
can reclaim space in the private pnpm v11 cache above the trigger. It uses filesystem
compression, verifies both files against the content-addressed SHA-512 name, skips
linked files, ACLs and pre-existing resource forks, and atomically replaces only
smaller verified representations.

A cold file selection for the macOS tool can also list reviewed `roots` under
terminal private `.local` cohorts and exact `files` with `path` and `sha256`.
Every selected path must belong to a registered terminal output. The owner checks
open files and processes for the selected cohorts before changing representation.
Use `qualification_capacity.py --store "$STORE" verify-restore --identity ID --sha256 SHA`
for a bounded full restore and inventory verification in disposable store scratch.

A historical worktree’s exact top-level dependency directory also qualifies when
a terminal owner explicitly registered it. A separately authorized
`--user-pnpm-cache` selects the current user’s pnpm v11 content-addressed payload
directory only when the owner already counts that store and its quiescence check
passes. Each replacement preserves its SHA-512 name, metadata and independent inode
semantics. `--to-target` continues a triggered campaign to the low-water mark.

For standalone ZIPs and existing chunk packs that must remain directly readable, a file selection can name
the owned `history` directory as its sole root. The macOS tool checks each original
ZIP digest against its index. A pack must be referenced by a digest-verified
manifest. Both its source and compressed copy must match the reviewed whole-file
digest. The tool keeps the original path, bytes and index. Historical
applications that open the raw ZIP directly can continue doing so.

Set `includeManagedScratch` in the store enrollment to include future archived
temporary trees from runs that explicitly pass `--cold-temporary-history`.
Selection requires the terminal owner state, matching temporary path, retirement
receipt, archive index and original SHA-256. The maintained restore command
resolves these archives. Output directories, signed products, and rollback
archives remain individually enrolled.

## Shared core UI comparison

`node --test build/core-ui-fixture.test.mjs` is the fast check. The ordinary
`check:fast` job discovers it with the other build tests. It checks committed
geometry, style removal, exact Pressable events, and retirement using the public
React Native fixture in `examples/minimal/src/coreUiFixture.tsx`.

For an archive under review, copy that same fixture into an isolated app
generated by the archive and into a standalone React Native Web reference.
Use React and React DOM 19.2.8, React Native Web 0.21.2, esbuild 0.28.1, and the
starter's Inter 400 font bytes. Use the public `pnpm dev` command on the Roku
side. On the web side map `react-native` to `react-native-web` in the browser
bundler. Set the body margin to zero and load the same Inter asset with
`@font-face`. Each launcher renders the fixture as
`<CoreUiFixture left={96} top={64} onEvent={record} />`. Expose the event array at
`globalThis.__CORE_UI_EVENTS__`, and append to it from a stable `record` callback.

With the two loopback development servers started, run:

```sh
node scripts/qualify-core-ui.mjs ROKU_PREVIEW_URL RN_WEB_URL NEW_OUTPUT
```

The runner uses Chromium and ffmpeg. It captures three 1920×1080 frames per
backend at device scale 1, checks the semantic activation sequence and scores
named pixel probes. It retains original frames and raw readings. Use a fresh
output directory for each run. A missing state or failed probe exits nonzero.
The only nonzero browser tolerance is two color levels for leaf alpha rounding.
A missing mask exposes the red or blue art band at a corner. Setting
`opacity: state.opacity ?? 0.25` must fail the third-state opacity probe.
Make these edits in a disposable consumer, restore both files, and rerun.

The standalone catalogue uses `examples/minimal/src/catalogAdoptionFixture.tsx`
with the documented registry entry and `react-native-safe-area-context` 5.8.1.
Pass a stable `onEvent` callback from the launcher and expose its events as
`globalThis.__CATALOG_TRACE__`. Run
`node scripts/qualify-catalog-preview.mjs PREVIEW_URL NEW_OUTPUT` against that
app. The trace distinguishes each list mount, row focus request and observation,
and Select down/up leading to `onPressIn`, `onPressOut` and `onPress`.

### Physical Roku clipping

Run the [paired installer screenshot test](https://github.com/react-native-roku/react-native-roku/blob/HEAD/benchmarks/clipping/README.md)
against the exact archive. One developer-mode Roku supplies the install, input,
native state and original screenshots. All four corners in three states must
pass in two captures each, with a visible square control and verified restoration.
An inconclusive result leaves the gate open. The six software lanes and the
fresh device app journey have separate evidence.

For the historical per-pixel JPEG diagnostic, capture the same initial state and the states after
one and two spaced Select presses with the Roku developer installer. Preserve
the original JPEGs, installer checksum, exact ZIP and native input observations.
Score the stills with the same coordinate table and a twelve-level RGB allowance
for JPEG:

```sh
node scripts/qualify-core-ui.mjs --native-stills NEW_OUTPUT STATE0.jpg STATE1.jpg STATE2.jpg
```

Review new probes and tolerance changes against both positive and negative
captures. Keep the fixture's public JSX shared when adding cases. Record the
stock native reference and physical device as separate executions. Browser
keyboard and pointer events establish shared Pressable behavior within the
browser harness. A held handheld remote needs physical observation.
