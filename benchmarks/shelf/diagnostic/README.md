# Native focus, React work, and immediate Select

Use the verified renderer tarball and the shelf's device handoff, installer
receipt, and rollback procedure. The probe adds no renderer API. It instruments
a disposable extraction of the selected tarball and the fixture source. Changes
to the underlying renderer and changes to the probes use separate archives.

## Prepare a matched control and diagnostic shelf

```sh
BASE=/absolute/path/to/runtime-baseline.tgz
mkdir -p .local/shelf-probes/unpacked .local/shelf-probes/marked
tar -xf "$BASE" -C .local/shelf-probes/unpacked
python3 benchmarks/shelf/diagnostic/instrument.py .local/shelf-probes/unpacked/package
(cd .local/shelf-probes/unpacked/package && pnpm pack --pack-destination ../../marked)
ROKU_SHELF_ACTIVATION=1 node benchmarks/shelf/prepare.mjs "$BASE" .local/shelf-probes/control react
ROKU_SHELF_ACTIVATION=1 ROKU_SHELF_MARKS=1 node benchmarks/shelf/prepare.mjs \
  .local/shelf-probes/marked/react-native-roku-0.2.0.tgz .local/shelf-probes/diagnostic
```

The patcher verifies exact source anchors. Its probes apply to the verified
baseline and the queue candidate. Apply any tested candidate patch to a separate
extraction and pack it before applying the probes. Use the exact unmarked candidate
archive for package qualification, ordinary timing, and screenshots. The
`react` option prepares only the React Native ZIP. The full build also prepares
Solid with its BrightScript entry point. `ROKU_SHELF_ACTIVATION=1` enables the
Select press workload in both fixtures. Leave it unset for the styled-text toggle.

## Run device cohorts

Enable SDK Perfetto for the developer channel before installation. Begin each
cohort with the installer checksum and byte count verified, a foreground shelf,
and Card 1 selected. Use fresh output directories. Use the ordinary replay on
the exact unmarked control and candidate in alternating installs. Run SDK-only
traces on those builds separately to check instrumentation overhead against the
marked trace. For a marked build, collect the 30-move trace as documented in the
shelf guide, then capture activation in a separate recording.

```sh
export ROKU_BENCHMARK_HOST=your-roku-host
export ROKU_BENCHMARK_OUTPUT_MODE='1080p60 SDR via HDMI'
ROKU_BENCHMARK_COHORT=burst node benchmarks/shelf/trace.mjs /path/to/rk \
  react .local/shelf-probes/diagnostic/react.zip .local/react-receipt.txt .local/react-burst
trace_processor_shell -q benchmarks/shelf/diagnostic/timeline.sql \
  .local/react-burst/device.perfetto-trace > .local/react-burst/timeline.csv
python3 benchmarks/shelf/diagnostic/chronology.py .local/react-burst > .local/react-burst/chronology.json
node benchmarks/shelf/diagnostic/score-burst.mjs .local/react-burst/chronology.json
```

Use the same trace export and chronology script for ordinary marked runs.
For a marked 30-move shelf trace from the stable-placement renderer, the phase
scorer requires the matching native focus observation and React input ID for
each move.

```sh
python3 benchmarks/shelf/diagnostic/score-phases.py .local/react-warm/chronology.json
```

The render interval includes synchronous React scheduling from the event
callback's return to the first host commit boundary. Host mutations end
when React hands control to the renderer's commit, which prepares layout
synchronously for the warm fixture. The device-to-JavaScript delivery interval
is also reported separately.
Use `solid` and the matching ZIP and receipt for the Solid run. The burst
starts on `shelf-0`, sends Right, Right, Right, Left, Select and saves actual
host dispatch times. Run one 300 ms paced trial, then three 40 ms trials.
Host commands follow a fixed schedule without waiting for ACKs or tree polls.
Reset between trials after the terminal snapshot. A burst replay summary
covers preflight, transport and the terminal snapshot. The trace scorer
establishes the ordered native edges, complete native and callback focus
sequences, and exactly one press handler call on `shelf-2`.

The React fixture appends the press ID and cumulative count to its selected
title after the first press. For the unmarked ZIP built with
`ROKU_SHELF_ACTIVATION=1`, retain the paced and rapid outcomes with:

```sh
ROKU_BENCHMARK_COHORT=burst ROKU_SHELF_VERIFY_ACTIVATION=1 \
  node benchmarks/shelf/replay.mjs react EXACT.zip RECEIPT.txt NEW_OUTPUT
```

Begin with a newly installed fixture on Card 1 and an empty press count.
The verifier requires exactly one new press on `shelf-2` per trial.
Use a clean fixture instance for ordinary timing so its title has no press
suffix. For a marked burst, set the same verification flag when collecting
the trace to check the fixture outcome alongside the trace scorer.

The probe captures render-thread focus observers, SDK delivery and app markers
in the Perfetto clock domain. Each native focus observation has a card-specific
observer name and a nested print slice emitted only while that node has focus.
JS markers include the device performance clock sample and available input
and focus generation IDs. The chronology reports offsets and residuals
between the two clocks. Timing conclusions use Perfetto timestamps directly.
Keep actual down and up times, all transactions, missing events, and the
raw trace. Host send and response timings and render or swap timestamps are
separate measurements. First visible highlight remains `UNMEASURED` until a
synchronized display recording establishes it.

Run `node --test benchmarks/shelf/burst.test.mjs` to exercise the failure cases.
