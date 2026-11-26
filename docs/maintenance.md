# Maintaining react-native-roku

This is an unpublished experimental platform package. Keep it independent of any
application's routes, server contracts, query policy and focus topology. The
React application owns those decisions; this package owns renderer and native
mechanics. The developer preview uses the MIT license.

## Setup and checks

Use the Node version in `.node-version` and pnpm from `packageManager`:

```sh
pnpm setup:repo
pnpm run doctor
pnpm check:fast
pnpm check
```

`setup:repo` installs the frozen graph and checks Node, pnpm, macOS/Linux, ZIP
tools, Chromium and the pinned SDK/runtime cohort. It does not install system
software, change shell configuration, access a device or publish. Use
`ROKU_TEST_CHROMIUM` for a nonstandard Chrome/Chromium executable. `pnpm setup`
is pnpm's own global setup command; the repository command is `setup:repo`.

`check:fast` checks formatting, React and SDK types, host/build contracts,
package boundaries, public exports, toolchain consistency and the adapter
inventory. Package checks also parse authored BrightScript helpers before
packing or consumer installation; the SDK lane separately parses the generated
channel. `check` additionally qualifies independent packed consumers, an
official SDK channel, and a real browser edit/error/fix/activation journey.
It also runs the optional Metro build, reload and Fast Refresh lanes locally. The exact-archive candidate
runner used by runtime adoption checks all six lane reports against that same
archive hash.
Intentional malformed source in the browser journey produces an expected
compiler error before recovery. Both consumer installers allow metadata fetches
on a fresh machine instead of assuming the maintainer's offline cache exists.

GitHub Actions runs the quick Ubuntu lane on main pushes and pull requests,
with a five-minute job limit. A manual workflow dispatch with `full_qualification` enabled runs all six lanes
against one packed archive per host, then verifies the seal. Linux and macOS
have separate evidence. Routine CI also checks source independence and runs the
offline navigation regressions. The standalone release workflow prepares its own
exact archive before a separately authorized publication.
A workflow definition is not execution evidence; retain the run and artifact
records for any claimed remote pass.

Hosted Linux jobs remove unused preinstalled toolchains/container images and
install the qualification owner's Python/lsof/ZIP prerequisites before checks.
The accepted main's November 11 fast job refused its storage startup floor
before running checks; runner preparation funds that same unchanged gate.
Local execution does not assert a subsequent remote pass.

## Qualification storage

Under the owner lock, admission identifies terminal workspaces eligible for
retirement. An ordinary launch with none to retire uses one fresh retained-byte
measurement. A retirement still requires admission before mutation and a fresh
measurement after it. Cold-history maintenance that writes a cycle record,
inspects enrolled archives, or defers after an error also invalidates its
measurement. Startup receipts distinguish retirement discovery from compaction.

Maintainer tests require Python 3.9 or later. `pnpm test`, `check:fast`, `check`,
and all six qualification CLIs
delegate to one storage owner before launching work. Public consumer builds do
not require this maintainer helper. `pnpm check` packs once, qualifies all six
lanes against that archive and verifies the sealed result.

Defaults reserve 20 GiB of available disk, require 32 GiB before starting,
limit a run to 12 GiB of tracked allocated files, and limit managed retained
outputs/history to 20 GiB. Explicitly tracked existing reuse inputs and stable
generated outputs also count. Another run must fit within the retained budget too.
Only one managed heavy run can hold the shared lock. Available disk is polled
every second; file allocation is sampled every five polls. These checks cannot
prevent unrelated processes from filling the disk between polls.

An owned store may retain an explicit workspace approval in `policy.json`.
Independent processes resolve that file through this same owner; other stores
keep the conservative defaults. The file binds the canonical store, workspace,
account UID, retained ceiling and authorization. Malformed, foreign or symlinked
configuration fails closed. Configure only an explicitly approved ceiling, while
the heavy lock is free and all prior owners are terminal:

```sh
python3 scripts/qualification_storage.py configure --store=/absolute/workspace/.react-native-roku-qualification --workspace=/absolute/workspace --history-limit-gib=64 --authorization='Owner-approved qualification capacity'
python3 scripts/qualification_storage.py status --store=/absolute/workspace/.react-native-roku-qualification
python3 scripts/qualification_storage.py admit --project="$PWD" --store=/absolute/workspace/.react-native-roku-qualification --run-limit-gib=12 --retained-headroom-gib=2
```

The configuration ceiling is **80 GiB total retained**, with **12 GiB maximum
per run**, **20 GiB physical reserve**, and **32 GiB startup floor**. Record any
workspace-specific approval through `configure`. New stores retain the 20 GiB
default.
It is local workspace state, not a repository-wide default. Keep it
with the shared store across sessions. `status`, `admit`, `run`, `archive` and
`restore` report the effective policy and its provenance. Original historical
state policies are never rewritten. Explicit Python `Policy` callers remain
available for separately authorized task policies and small test fixtures, and
are identified as `explicit-policy`.

Admission requires the larger of the startup floor and reserve plus the complete
run/recovery reservation. Retained usage plus the run reservation and optional
`--retained-headroom-gib` must fit the ceiling. Before a dependency transaction,
budget its complete recovery schedule and use at least **2 GiB** additional
retained headroom outside the run reservation. `admit` is a read-only locked
snapshot, not a reservation; `run` rechecks while acquiring the actual owner:

```sh
python3 scripts/qualification_storage.py run --project="$PWD" --store=/absolute/workspace/.react-native-roku-qualification --run-limit-gib=12 --retained-headroom-gib=2 --kind=benchmark --dynamic="$PWD/.local/benchmarks" -- COMMAND ARGUMENTS
```

Allocation is measured freshly; no cross-run usage cache authorizes admission.
The walker visits overlapping namespaces once, counts actual file blocks with
hard-link deduplication, and refuses unreadable trees. It does not follow links.
Under the held lock, startup checks admission before compaction and again
afterward. The latter includes the full run/recovery budget, so compaction does
not also repeat a weaker retained-only scan immediately before it. Standalone
compaction still enforces its own retained ceiling; archive overlap checks remain.

Owner records retain `startupTiming`: total startup duration and inclusive phase
durations for retained-root discovery, allocation, compaction, quiescence,
archival and initial run allocation. Nested phases overlap; do not sum them as
wall-clock time. `admit` returns `timingPhases` on success. Refusals state the
available/required capacity or retained/run/recovery/ceiling values and shortfall.
The tiny isolated CLI test fixtures supply synthetic free space explicitly;
production commands and production floor tests keep the actual policy.

Declare every output/reuse namespace needed by that schedule using the existing
`--track`, `--dynamic` and `--evidence` options. Children inherit the actual owner's
session, temporary namespace, recorded policy and heavy lock; they cannot start
a second owner or enlarge its budget. The canonical Python session validator
checks nonce, terminal status, canonical paths, live process ancestry and lock
ownership. The JavaScript bootstrap uses that validator too. Never construct
session credentials. Configuration is captured as an immutable run input.

The owned store defaults to `../.react-native-roku-qualification`, outside both producer
and consumer checkouts; `RNR_QUALIFICATION_STORAGE_ROOT` can select another
owned location. Temporary consumers and browser profiles use its `workspaces`
directory. Successful sealed cohorts retain their evidence and retire their
temporary environments and unretained dependency caches. Failed/unsealed work
keeps its inputs; earlier raw temporary environments are compacted when their
entry types can be archived losslessly. A terminal test fixture containing a
symbolic link is compacted using versioned link metadata without following or
flattening its target. FIFOs, sockets and other unsupported entry types stay raw,
with an explicit archive refusal in their owner record; those bytes remain charged.
Link archives use `rnr-qualification-archive/v2`, which old restorers reject.
Regular-file archives keep their existing format. Manual archive calls still
refuse links unless `--preserve-links` is explicit. Restore refuses link archives
until the operator inspects their recorded targets and supplies `--restore-links`.
That option recreates original links, including absolute and dangling targets,
only after writing regular files; it never reads or writes through their targets.
No archive entry may descend through a file or link, and linked destination
ancestors reject before extraction.
Quiescence, changed-input failures, all admission limits and manual archive
refusals remain enforced. Archives preserve paths, file contents, modes and times,
deduplicate equal contents, and verify every object before source retirement.
No retained inventory's `node_modules` namespace is treated as a cache.
The serial package runner also retires completed lanes' reinstallable
dependencies before starting the next independent lane. It waits for the SDK's
dependent browser journey, verifies the passed archive-bound proof and retained
inputs, and refuses active or unowned trees. Generated and captured files remain
available for final sealing; each retirement has a record in the cohort.

Inspect usage and compact a terminal, superseded private evidence directory:

```sh
python3 scripts/qualification_storage.py status --store=../.react-native-roku-qualification
python3 scripts/qualification_storage.py archive --root=/absolute/.local/old-evidence --store=../.react-native-roku-qualification --manifest-sha256=RECORDED_FILES_JSON_SHA256 --retire
python3 scripts/qualification_storage.py restore --archive=/absolute/history/ARCHIVE.zip --sha256=RECORDED_ARCHIVE_SHA256 --destination=/absolute/fresh-restored-evidence
```

Retirement requires process/open-file inspection (`ps` and `lsof`) and refuses
active, changed, unowned or symlinked evidence. Index records under the store's
`index` retain original locations and archive hashes. Restore refuses existing
destinations and verifies the original inventory. When a budget is full, stop
and compact or explicitly retire verified environments; do not raise limits or
delete source captures to make a test pass. Storage-limit exits are failures,
never qualification passes.
Cleanup reaps its direct `Popen` child even when the process-group signal reports
absence, observing the child's actual exit status rather than inferring it from
the group probe. A denied probe remains an error; interrupted evidence and the
caller's signal handler retain the diagnostic behavior above.

Success-only temporary retirement (including `--cleanup-success`) also verifies
that its root is unchanged, retained evidence does not overlap it, and no process
or open file still uses it. Busy or denied inspection records an interrupted
`temporary-cleanup` phase and preserves the data. A successful child exit alone
does not authorize deleting a detached process's working files. Durable external
evidence remains retained; failed children never use this cleanup path.

Besides private `.local` evidence, an explicit `archive --root ...` may seal and
retire a child of a project's `build-artifacts` only when a terminal owner record
names that exact evidence directory. The manifest hash, shared lock, quiescence,
unchanged-input verification and policy checks still apply. A project root,
arbitrary cache, active run or merely tracked output is not admitted by this rule.

## Renderer fixture comparisons

Run the package-owned catalog workload on the exact archive.

```sh
node scripts/host-performance.mjs --archive=/path/to/runtime.tgz --output=/path/to/new-directory
```

The runner installs a frozen independent consumer and verifies the renderer inputs against the tarball. For physical workloads see [navigation](https://github.com/react-native-roku/react-native-roku/blob/HEAD/benchmarks/navigation/README.md).

## Compatibility ownership

`compatibility/registry.json` owns the adapter aliases, reviewed upstream
versions, exported runtime API inventory, member/prop surfaces, contract test
references, implementation limits and device-pending status. The bundler and
consumer TypeScript paths use this alias owner. `check:compatibility` compares
the recorded surface with the actual TypeScript exports. A new export begins as
`review-required`; author its behavior/failure/cleanup contracts and review its
limits before changing that status. Refresh inventory explicitly with:

```sh
pnpm compatibility:refresh
pnpm check:compatibility
```

An exported type is not proof of complete implementation. Partial adapters,
unsupported placeholders, open SVG attributes and dynamic/spread usage remain
explicit. Host contracts cannot certify firmware, secure storage, decoding or
native accessibility. Do not turn device-pending into device-tested without
source- and artifact-attested device evidence.

The public `auditCompatibility` helper checks literal imports, members and JSX
props. A consuming application supplies its workspace prefixes and reviewed
third-party library versions. New dependencies and unregistered API usage must
fail review. A consumer may track exact existing gaps, with reasons and bounded
occurrence counts; those gaps are debt and must remain visible in reports.
Never regenerate a gap baseline automatically during build or package update.

`pnpm test:metro` is a separate finite local qualification lane for the optional
Metro resolver/Babel transformer. It installs the actual archive and the reviewed
optional tool cohort, retains failure evidence, and compiles cold production and
development output through the public frontend and project/SDK builders, using
both entry conventions, full Intl data and compiled CSS interop. It does not
expand the automatic CI lane.
Set `ROKU_QUALIFY_ARCHIVE` to test an existing archive, `ROKU_QUALIFY_EVIDENCE_DIR`
for a durable evidence root, and `ROKU_HERMES_EXECUTABLE` for actual host-Hermes
execution. An unset Hermes path is recorded as not requested. The source/maps,
host runners and SDK payloads remain in its owned workspace after completion;
firmware and Fast Refresh need separate evidence.

`pnpm test:metro-development` generates another fresh Metro app from the archive,
installs it, runs types/doctor and the real public CLI SDK build, then reuses
`qualify-development.mjs` for fonts, edit/reload, syntax-error retention,
correction, session restoration and activation. Its SDK input report comes from
that successful build. Preexecution helper/installed-source copies, logs,
generated projects and ZIPs remain under its owned `.local` evidence directory.
This lane keeps full reload distinct from state-preserving Fast Refresh. The
existing manual Actions matrix remains the default esbuild SDK/browser lane;
these additional Metro lanes run locally and do not expand automatic CI.

`pnpm test:fast-refresh` installs another archived Metro consumer and exercises
the public project development server in Chromium with dynamic code disabled.
It checks preserved state, module/render/syntax failure and correction, changed
hook signatures, resource/asset/font/config reloads, rapid edits, both entry
conventions and complete retirement. Each stage retains its inputs, browser
snapshot, actual preview/patch programs and source maps. Required font/image
bytes are retained separately. `ROKU_QUALIFY_ARCHIVE` and
`ROKU_QUALIFY_EVIDENCE_DIR` select the same archive/evidence contracts as the
other lanes. This is browser Canvas evidence; native SDK package reload and
native stateful hot reload require separate mechanisms and qualification.

`compatibility/public-api.json` classifies every package export by audience:
application, advanced host, build, testing, types or metadata. All are currently
experimental. Adding an export without a classification fails package checks.
Avoid consumers reaching through private filesystem paths to repair a missing
public contract.

## Development lifetime and timing

The watch server serializes/coalesces builds and keeps the last good app after
an error. Its owned workspace retains two published generations and any active
candidate. Normal shutdown removes the workspace. Startup removes abandoned
workspaces only when they have the ownership manifest and their process is no
longer alive. Active, unowned and symlinked directories are preserved.

Source directories use recursive filesystem events. Individual configuration
files use a 100 ms metadata check, including inode and timestamps, because an
atomic rename notification may not identify the destination file reliably.
Watches start before cold compilation; edits during it coalesce into a fresh
candidate before publication. Close/error paths retire both event watchers and
file polling timers.

`/__roku/status` includes a bounded window of build durations, successful
generation count, failure count and edit-to-ready timing.
Metro development uses React Refresh at safe component boundaries.
The esbuild workflow and production-profile previews use full page reload.
Configuration, dependency graph, runtime, asset/font and unsafe module lifetime
changes also reload. Syntax/build errors retain the last good app. Static update
chunks are loaded before applying factories to the existing Metro runtime;
source maps refer back to original source. A discarded/coalesced candidate never
becomes the refresh base. `createRokuProjectDevServer` owns this lifetime for
custom callers, including watchers, refresh session and workspace cleanup.

## Dependency and release policy

`config/toolchain.json` defines the accepted Node/pnpm and runtime cohort. React,
reconciler and scheduler move together; all SDK packages share one reviewed
version. NativeWind/CSS interop/Tailwind and Yoga have explicit upgrade groups.
Dependabot proposes grouped changes; do not auto-merge upgrades. Update the
cohort, templates, adapters, inventory and conformance evidence together.

Before 1.0, a breaking public contract increments the minor version; patch
releases preserve the documented subset. Record changes in `CHANGELOG.md`.
Published versions are immutable.

```sh
pnpm release:prepare
pnpm release:check
```

Preparation prints blockers without publishing. The check fails while the
package is private/UNLICENSED, lacks a source commit, has a dirty tree, lacks the exact
version tag, or has inconsistent public API/cohort/changelog metadata. Stable
1.0+ releases additionally need an explicit qualified release policy and device
evidence. No maintenance command commits, tags, pushes or publishes.

Dispatch `release.yml` at the reviewed source ref with the inputs blank to
prepare. The job packs once through `pnpm check --archive=ABSOLUTE_TGZ --output=ABSOLUTE_EVIDENCE`,
uploads the tarball and six-lane evidence as `release-candidate`, and verifies
a fresh download. Record the run ID, source commit and both SHA-256 values from
the run summary. Verify an independent download before building the device
consumer from it:

```sh
node scripts/qualify-package.mjs --verify-only --archive=DOWNLOADED_TGZ \
  --output=DOWNLOADED_EVIDENCE --manifest-sha256=ORIGINAL_SEAL_SHA256
```

The first npm submission requires an approved public GitHub repository matching
`package.json` and the protected `npm-release` environment. For a new package,
the owner supplies an npm granular token with stage-only permissions as
`NPM_BOOTSTRAP_STAGE_TOKEN` on that environment. Staging a new name creates a
public `0.0.0-stage` placeholder. The owner can configure
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for this
repository, `release.yml`, and `npm-release` once the package exists, then remove
the bootstrap secret and revoke the token.

After the fresh Ultra journey and [physical Roku clipping check](qualification.md#physical-roku-clipping)
pass on ZIPs built from that archive, obtain owner authorization. Supply the compact verified JSON as the staging input `clipping-receipt`. Dispatch the same workflow
on `v<version>` with `preparation-run`, `tarball-sha256` and `seal-sha256` from
the original run. The job checks the run's source commit and both digests,
downloads and verifies the sealed files, and stages the tarball with public
access, provenance, and the `preview` dist-tag. It does not repack. Inspect the
staged version and download it in an empty directory to compare its SHA-256
with the reviewed tarball. The owner uses `npm stage approve <stage-id>` with 2FA
to publish those bytes and can verify the tag with `npm view react-native-roku@preview version`.
See [npm staged publishing](https://docs.npmjs.com/staged-publishing/).

## Device evidence

The public Node device helper implements ECP requests, observation parsing and
developer-installer screenshots without putting passwords in command arguments
or reports. It follows the installed SDK's public developer-installer behavior;
retail devices need not expose the privileged ECP screenshot endpoint. See
[Roku ECP](https://developer.roku.com/dev/docs/external-control-api).

Use the [standalone navigation suite](https://github.com/react-native-roku/react-native-roku/blob/HEAD/benchmarks/navigation/README.md) for physical runs. Supply device credentials locally. Store receipts outside the checkout. Score SDK swaps, settled pixels, and physical presentation separately.
