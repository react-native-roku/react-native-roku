# Roku Ultra shelf benchmark

This benchmark renders a 1920 × 1080 shelf of 24 cards through public React
Native APIs or the Solid SDK. Each app uses SDK 2.19.1, its debug compiler
preset, the same Inter Regular font bytes, and the same fixture data. Solid's
direction handler uses the shared row and column edges. React Native uses its
ordinary geometry-based TV navigation and the replay checks it against those
edges. React Native's Select stress toggle is reserved for a separate
styled-text workload. The [focus timeline and burst protocol](diagnostic/README.md)
adds matched Select activation and captures native focus independently of polling.

## Build the independent fixtures

Use the repository's pinned Node and pnpm versions and the ZIP tools. The
sample builds its own consumers in the supplied output directory. Any Roku
developer password is local to the device installer, and the fixtures run
using only the fixtures and public dependencies.

```sh
mkdir -p .local/shelf-archives
pnpm pack --pack-destination .local/shelf-archives
node benchmarks/shelf/prepare.mjs .local/shelf-archives/react-native-roku-0.2.0.tgz .local/shelf-build
```

The React Native fixture installs the specified tarball with the frozen
standalone dependency graph. Use archives from the pinned renderer dependency
cohort. The preparation command copies the input archive, hashes it, builds
both SDK channels, checks the ZIPs and verifies their font bytes and manifest
settings. Keep the ZIPs and `inputs.json` and `zips.json` with the run. Builds
may embed paths and timestamps. For a literal repeat, reinstall the frozen
ZIPs instead of rebuilding them.

## Ordinary scrolling catalog

Set `ROKU_SHELF_WORKLOAD=catalog` for build, replay, trace and rescoring. Both
consumers use the same 24 cards, short and wrapping titles, clipped scroll
window and Detail → Back behavior. The React app uses Pressable, Text,
ScrollView, BackHandler and React state. Its experimental focus presentation
is disabled in this workload. The default shelf remains the opt-in regression.

```sh
export ROKU_SHELF_WORKLOAD=catalog
node benchmarks/shelf/prepare.mjs CONTROL.tgz .local/catalog-control
node benchmarks/shelf/prepare.mjs CANDIDATE.tgz .local/catalog-candidate react
node benchmarks/shelf/prepare.mjs CONTROL.tgz .local/catalog-solid-full solid-full
```

The `solid-full` command builds `solid-full.zip` at version 0.2.0 with native
wrapping and 39 px line boxes. The frozen catalog has one-line and three-line
titles. The reference uses the matching 39 or 117 px Label height and zero
extra line spacing. Compare the rendered title crop and the world-space
bounds because the React title inherits its translation from a parent.
Keep the original 0.1.0 ZIP for historical measurements.

Use the same authored consumer revision and dependency lock for all legs. Only
the React renderer tarball and its integrity entry change. Run at least 30
scored moves per build in each order. Run the exact same ZIP again as a control
for repeatability. Use SDK Perfetto without application probes for decisions.
Keep traces with dropped packets or missing endpoints as failed attempts.

Set `ROKU_BENCHMARK_COHORT=journey` on a fresh catalog launch for correctness.
The replay scrolls to the third row, reverses direction with rapid inputs,
immediately presses Select, and checks the detail focus, returned card and
restored scroll offset. It records this journey independently of warm latency.

`diagnostic/catalog-geometry.py` adds native font timings to an unpacked
archive in a disposable directory. Keep the instrumented build separate.
The `catalog.geometry` trace event records total geometry time and native
line-height and width calls. The device capture establishes render and
completed-swap timings. First visible highlight requires synchronized display
capture.

## Fast host measurement

```sh
node benchmarks/shelf/host.mjs .local/shelf-build .local/shelf-host
```

Pass `host` as the final argument to `prepare.mjs` to install only the React
Native consumer for host work. The benchmark bundles the renderer from the
isolated installation and checks bundled renderer source against the tarball.
It runs the canonical counting-port workload at 12, 72 and 240 cards. It
retains raw timings, native writes, layout calls, Yoga allocations, cleanup
results and full native field-plan materializations. Structural counters run
in a separate process and bundle. Each timing round uses 40 measured focus
changes per size after warm-up. Compare matching rounds on an idle machine.
Host timing ends at `whenCommitted()`.

Pass `shelf` as a third argument to run the actual 24-card React Native app
through the same warmup and 30 directions as the Ultra:

```sh
node benchmarks/shelf/host.mjs .local/shelf-build .local/shelf-host-device-shape shelf
```

The host acknowledges each focus request through a recording SceneGraph port.
It runs fixed static text, fixed changing text and a longer, wrapping title
without an explicit label height. Use `structure.json` to inspect individual
layout dependencies, Yoga text callbacks, solved rectangles and text field
measurements. Use the separate `timing.json` for host timing, which includes
the synthetic focus delivery and ends at `whenCommitted()`.

## Physical workflow

1. Confirm the device handoff and keep a verified rollback ZIP. Record the
   current development channel and its checksum. Use one Ultra, the same
   display settings, the same host and network connection for all runs. Record
   the configured HDMI resolution and refresh rate separately from Roku's
   reported UI resolution. Use a fresh output directory for every attempt.
2. Open the Roku Development Application Installer and install or **Replace
   with zip** using the frozen Solid or React Native archive. Wait for **Install
   Success**. Save the displayed **Currently Installed Application** checksum
   and byte count in a local text receipt. The runner compares both with the
   selected ZIP before sending any keys.
3. Leave the newly installed fixture foregrounded on Card 1. Perform an
   alternating series such as Solid, React Native, Solid, React Native. Use
   the same warm path each time. The script runs an unscored Right/Left pair,
   two one-second warm-up dwells and the shared 30-move schedule. It waits
   200 ms after each successful move. Its pre-key sample must match the old
   card, and a single later sample must report both the new card's native
   focus and selected title. A failed preflight or step stops the cohort.
4. Run cold launch and Perfetto as separate cohorts. Run cold launch after the
   warm cohort and retain its readiness failures independently. If an
   endpoint becomes unhealthy, retain that failure and establish read-only
   readiness before any new measurement. Reinstall and verify the rollback
   after device work. Check the restored foreground channel and closed
   playback state.

```sh
export ROKU_BENCHMARK_HOST=your-roku-host
export ROKU_BENCHMARK_OUTPUT_MODE='1080p60 SDR via HDMI'
node benchmarks/shelf/replay.mjs solid .local/shelf-build/solid.zip .local/solid-install.txt .local/solid-1
node benchmarks/shelf/rescore.mjs .local/solid-1
node benchmarks/shelf/scene.mjs .local/solid-1 > .local/solid-1-scenes.json
node --test benchmarks/shelf/score.test.mjs
```

Use `react` with the React Native ZIP and its own installer receipt.
`ROKU_BENCHMARK_COHORT=cold` performs only termination, launch and Card 1
readiness. For a diagnostic run, enable the SDK's Perfetto recorder for the
development channel before starting the app, then call `trace.mjs` with the
SDK `rk` path followed by the same four replay arguments. The trace run needs
Card 1 and produces a separate trace and replay. Export the device-clock
events and score the ordered key sequence with these commands.

```sh
trace_processor_shell -q benchmarks/shelf/timeline.sql .local/trace/device.perfetto-trace > .local/trace/timeline.csv
python3 benchmarks/shelf/trace-summary.py .local/trace > .local/trace/device-summary.json
```

The trace may include buffered events from before the recorder connected.
The summary matches the live warmup and schedule and reports any missing
tail inputs. A transaction, native field write, render and buffer swap have
distinct endpoints.

### Measurement boundaries

- **First visible highlight.** Capture the display at a known frame rate and
  record the remote actuation or command send on the same timebase. Retain
  the raw recording and per-move frame numbers. Record the alignment method,
  measured clock offset/drift and uncertainty from frame quantization, input
  marker and capture pipeline. If the capture chain cannot establish the
  interval, record `UNMEASURED`.
- **ECP and app tree.** Host monotonic timestamps cover command send,
  acknowledgement, query start and query completion. Raw XML permits
  checking focus, title and card highlight independently. Query cadence is
  75 ms after each unsuccessful read. First successful observations include
  network and polling. For an interval on the host clock, the start of the
  previous stale request and completion of the first matching request are
  conservative endpoints, assuming the expected state persists. A first-poll
  match has no post-send stale bound.
- **Device trace.** Perfetto provides device key events, SDK transactions,
  native calls where emitted, and compositor events. React commit and
  renderer field submission require explicit renderer landmarks for exact
  attribution. Keep any additional logging in a diagnostic cohort and use
  clock alignment before comparing device and host timestamps.
- **Visual correctness.** `scene.mjs` checks native card placement, colors,
  label bounds, text and highlight fields and summarizes their first observed
  changes. Compare settled native screenshots for Card 1 and the same moved
  card across builds. Screenshots establish settled appearance. Count new
  artwork or styled-text readiness separately from ordinary focus moves and
  cold launch.

Report individual samples, median, nearest-rank p95, worst case, input
failures and unattempted inputs. Record every preflight and timeout. Measure
repeatability before choosing a latency budget. The burst protocol checks the complete ordered focus sequence and the actual
press handler. Virtualization-boundary scrolling and Detail → Back restoration
are separate workloads.
