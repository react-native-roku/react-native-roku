# Navigation benchmark suite

Use the frozen 24-card ordinary catalog for measuring renderer changes and the independent 48-row holdout for checking whether the change generalizes. Each run has its own evidence directory. Python 3.9+ and the repository's pinned Node run the offline scorer without installing dependencies.

## Replay saved evidence

```sh
python3 benchmarks/navigation/suite.py test
python3 benchmarks/navigation/suite.py rescore path/to/marked-react-burst path/to/marked-solid-burst
python3 benchmarks/navigation/suite.py post-apply path/to/warm-marked --marked
python3 benchmarks/navigation/suite.py compare path/to/blocks.json --post-apply
```

For a raw burst capture with a replay summary and console log, use `suite.py extract burst RUN --processor /path/to/trace_processor_shell` to generate attribution and quality CSVs. Use `warm` for the paced trace. Extraction refuses to overwrite an existing CSV.
For the post-apply comparison, first record `device warm-fields` with separately marked copies of both exact ZIPs. The marked scorer requires the complete expected state after the second linked apply on every move. The unmarked scorer requires the same two linked applies before a qualifying render and reports the first swap separately. A changed apply sequence needs its own field attribution.

| Measurement                          | What earns credit                                                                                                                                                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warm first render and completed swap | A device-clock endpoint for that key in an SDK-only trace. Report scrolling and non-scrolling moves separately.                                                                                                                                                         |
| State-qualified burst swap           | The native focus, both highlight colors, complete title, width, height, line count, wrapping and scroll offset agree with the expected card when rendering starts. Its swap must finish before the next observed state transition.                                      |
| Input deadline                       | Of those moves, count how many swaps finished before the next device key-down. The final directional move uses Select as its deadline.                                                                                                                                  |
| Activation and Back                  | The native Detail tree identifies the expected card with the Back control focused. The restored tree identifies the original card, title, colors, bounds and scroll offset. This checks the observed result of Select. A callback count needs separate instrumentation. |
| First visible highlight              | Unmeasured by these endpoints. A settled tree or completed swap cannot identify the pixels in a displayed frame.                                                                                                                                                        |

The native scorer follows observer callbacks to their SDK apply completion, using trace flow IDs. It folds field changes into the current state across any number of transactions. A render that starts while a required update is outstanding earns no credit. It checks every card's highlight, including the old one. For each move the validity window ends at the next focus update or Select, or earlier if a required field changes. Each recorded native focus must correspond to one intended move in order. Older probes sample width and wrapping on title change. The supplied probe also observes changes to those fields independently.

`PASS` means every burst move met the next-focus-or-Select deadline. Always read the separate next-key count. `MISS` identifies moves with no qualifying swap. `FAIL` identifies replay or state-contract errors, including wrong activation. `UNKNOWN` identifies insufficient evidence, including absent native observations, trace loss, or an ambiguous pairing. All non-passes produce a nonzero exit with a JSON result. Retain that result. The field observer changes the workload. Use SDK-only ZIPs for the latency comparison and separate marked ZIPs for attribution.

The regression in `tests/cross-row.json` contains relative nanosecond times, observed state changes, render/swap pairs and source SHA-256 from an archived Ultra cross-row burst. It reproduces 0/11 before the next key and 1/11 before the next focus or Select. Synthetic regressions cover a single apply, split applies, coalescing, late swaps, stale title, stale paint and wrong activation.

## Run a device session

The device command takes an already-installed fixture, its matching installer receipt and a fresh output directory. Use the existing lease, installation and rollback workflow. Start each journey at its first card. The warm and burst fixtures use the ordinary catalog with experimental focus presentation off. For a full-title comparison, use a Solid ZIP that wraps the same text at width 1050 with one or three 39-pixel lines. The earlier ellipsizing Solid fixture measures a different workload. Record the package, ZIP, font and fixture hashes with the device model, firmware build and display mode.

```sh
export ROKU_BENCHMARK_HOST=your-leased-roku
python3 benchmarks/navigation/suite.py device warm react CONTROL.zip INSTALL.txt NEW_RUN --rk /path/to/rk --processor /path/to/trace_processor_shell
python3 benchmarks/navigation/probe.py CONTROL.zip NEW_MARKED.zip react
# Install NEW_MARKED.zip and retain its installer receipt before running the burst.
python3 benchmarks/navigation/suite.py device scrolling react NEW_MARKED.zip MARKED_INSTALL.txt NEW_SCROLL --rk /path/to/rk --processor /path/to/trace_processor_shell
```

Use `reversal` for an in-row reversal and `scrolling` for a burst across rows. Both send immediate Select and verify Back. `ROKU_BURST_SPACING_MS` defaults to 42. Match the spacing, route and instrumentation across React Native and Solid. Preserve the actual device input timestamps. `device held` sends one ECP Right key-down and one key-up, checks multiple moves followed by stable focus, then sends a fresh Select and verifies Back. Set `ROKU_HOLD_MS` if the device reaches the end of the row. `ROKU_HOLD_INJECT_REPEATS` sends the specified number of extra ECP down commands before release and requires that exact move count. Report those commands separately from a physical remote hold. The settled observations cannot count intermediate frames.

`device cold` verifies the dev channel became inactive before requesting launch. It records the host time to the first matching native tree and to the first correctly answered Right press. Keep cold launches separate from warm device-clock samples. Use `device catalog-cold react CATALOG.zip INSTALL.txt NEW_RUN` for the public package. It checks that the first Right skips the disabled card and shows the correct public catalog position. The public initializer catalog can run a residency soak with `device catalog react CATALOG.zip INSTALL.txt NEW_RUN --rounds 100`. It records mounted nodes and resident bytes when the device supplies them. `ROKU_CATALOG_CHECKPOINT_EVERY` sets the interval in rounds. `ROKU_CATALOG_IDLE_SAMPLE_MS` adds a final memory and geometry sample after that period without inputs. Repeat these lanes on a lower-end Roku when one is available.

`probe.py REACT.zip RECOVERY.zip react --recovery` marks a disposable copy that withholds the first positive native focus notification for Card 2. Install that copy and run `device recovery react RECOVERY.zip INSTALL.txt NEW_RECOVERY`. The replay requires one withheld notification, recovery to Card 2, activation, Back at the original offset, and a subsequent move to Card 3.

## Compare launch blocks

Use fresh launches in both orders. Here the directory names reflect collection order. Paths resolve relative to the manifest.

```json
{
  "blocks": [
    { "order": ["control", "candidate"], "control": "run-1", "candidate": "run-2" },
    { "order": ["candidate", "control"], "candidate": "run-3", "control": "run-4" }
  ],
  "excludedAttempts": []
}
```

For an excluded attempt retain its directory and add an object with `path` and `reason`. The report checks artifact identity within each role, distinct launches, firmware, resolution, schedule, input completion, endpoint completeness and trace quality. It reports per-launch median, p95 and worst, matched savings in each order, the range of same-build launch medians, and median absolute matched-move differences between same-build launches. Run identical artifacts in both roles for an A/A noise check. Additional moves within a launch share that launch's conditions. Repeat fresh blocks if a result is close to the observed noise. Freeze the screen, data, SDK, configuration and physical device across a comparison and check semantic eligibility before interpreting differences between frameworks.

## Reproduce the full-title Solid scorecard

The [archived Ultra comparison](results/2026-11-25-solid-shelf/README.md) includes [every timed move](results/2026-11-25-solid-shelf/scorecard.json). A reader can recalculate its statistics without access to the device. To collect a new comparison, use one developer-enabled Roku and a computer with the pinned repo tools and Perfetto trace processor. The physical endpoint is a completed SDK swap. Settled pixel fidelity has its own [Roku screenshot test](../clipping/README.md).

1. Freeze the package tarball, SDK, catalog, font, output configuration and route. Build the ordinary React shelf and full-title Solid reference with the commands below.
2. From those exact ZIPs build field observers with `probe.py`. Run one `warm-fields` journey per framework. The scorer learns which native transaction completes both highlights, full text, wrapping height, focus and offset for each marked move. One framework may use a single transaction and the other may split its update. A changed transaction count on an ordinary launch requires new field evidence. The paced shelf scorer currently has a 200 ms device-clock observation window per input. A missing endpoint fails scoring and the attempt belongs in the record. Use separate fresh launches of the ordinary ZIPs for timed `warm` journeys.
3. Declare at least two launch pairs in each order before running, for example React/Solid, Solid/React, Solid/React, React/Solid. Use the same physical Roku throughout. Record every attempt, retaining the trace, replay, build receipts and reason for each exclusion. Enter the `journey` directory of each accepted run in a blocks manifest following the example above. Include failed attempts in `excludedAttempts`. The tool can check supplied evidence. Completeness of the attempt log remains the collector's responsibility.
4. Run the scorecard command. It regenerates trace tables with the supplied processor, verifies the marked ZIP derived from each timed ZIP, enforces actual launch order, rejects reused traces and checks native state per move. It writes the report to stdout. `--format json` includes the full route, individual timings, ZIP and trace identities, per-launch tails, paired differences and same-build variation. Only selected public device fields appear in the output.

```sh
export ROKU_SHELF_WORKLOAD=catalog ROKU_SHELF_MARKS=0 ROKU_SHELF_ACTIVATION=0
node benchmarks/shelf/prepare.mjs "$RUN/runtime.tgz" "$RUN/react-build" react
node benchmarks/shelf/prepare.mjs "$RUN/runtime.tgz" "$RUN/solid-build" solid-full
python3 benchmarks/navigation/probe.py "$RUN/react-build/react.zip" "$RUN/react-fields.zip" react
python3 benchmarks/navigation/probe.py "$RUN/solid-build/solid-full.zip" "$RUN/solid-fields.zip" solid
# For each fresh launch, use lab.mjs with the appropriate renderer, ZIP and new output directory.
node benchmarks/navigation/lab.mjs warm-fields react "$RUN/react-fields.zip" "$ROLLBACK_ZIP" "$RUN/react-fields" --rk "$PWD/node_modules/.bin/rk" --processor "$TRACE_PROCESSOR"
node benchmarks/navigation/lab.mjs warm-fields solid "$RUN/solid-fields.zip" "$ROLLBACK_ZIP" "$RUN/solid-fields" --rk "$PWD/node_modules/.bin/rk" --processor "$TRACE_PROCESSOR"
# Repeat this warm command for each slot in the predeclared order, choosing its renderer and timed ZIP.
node benchmarks/navigation/lab.mjs warm react "$RUN/react-build/react.zip" "$ROLLBACK_ZIP" "$RUN/pair-1-react" --rk "$PWD/node_modules/.bin/rk" --processor "$TRACE_PROCESSOR"
python3 benchmarks/navigation/suite.py solid-report "$RUN/blocks.json" --react-build "$RUN/react-build" --solid-build "$RUN/solid-build" --react-fields "$RUN/react-fields/journey" --solid-fields "$RUN/solid-fields/journey" --processor "$TRACE_PROCESSOR"
```

Report scrolling and stationary medians separately. For a speedup claim, compare the candidate to the previous React build in both orders, report same-build variation and p95, and repeat on the independent image-backed screen below. For a parity claim, declare the acceptable median and p95 gaps before collecting and apply them to both workloads. Report correctness, bursts, soaks and model coverage alongside timing. A shelf result supports a claim about that shelf on that device.

## Exercise the independent screen

```sh
node benchmarks/navigation/holdout/prepare.mjs RENDERER.tgz NEW_FIXTURES
# Install the React Native or Solid holdout ZIP before its individual replay.
python3 benchmarks/navigation/suite.py device holdout react NEW_FIXTURES/react.zip INSTALL.txt NEW_HOLDOUT
```

Pass `react` to the preparation command to reuse an already-frozen Solid ZIP. Both implementations consume the same 48 stable route IDs, long and short titles, viewport, row dimensions and bundled image. React Native uses its public FlatList and Pressable. Solid renders a window of rows in a clipped group. The same replay scrolls to Route 8, opens Detail, narrows its title from 720 to 320, verifies Back restoration at the same vertical position, removes Route 8, and activates its successor. It requires a native poster with a URI under the focused row and records the settled trees. Pixel fidelity and image decode time require separate evidence.

Use `device holdout-timing` with `--rk` and `--processor` for the seven paced Down inputs. It retains the full correctness replay and reports device key-down to first swap, last linked apply and first completed swap after that apply for each move. For the visible-state endpoint, create a marked copy with `probe.py ... --holdout` and run `device holdout-fields`. The marked trace verifies focus, paint, the scroll position, titles and packaged image geometry on the three visible rows. Retain its `holdout-timing.json` with the original and marked ZIP identities. Pass that file to `suite.py holdout-timing UNMARKED_RUN --attribution MARKED_TIMING_JSON`. A different native apply sequence needs a fresh marked run. Use the holdout as a correctness check after a win on the frozen screen. Promote a renderer change only after its gains repeat across launch orders and both screens preserve focus, text, activation and geometry on hardware. Keep the opted-in shelf and ordinary consumer results separate.

## Deep scrolling and lab setup

See [standalone testing](../../docs/standalone-testing.md) for leased cold launches, the packaged catalog, gallery and settings routes, two-key and nine-key replays, marked field attribution and exact rollback.

## Deep and sustained routes

See the [standalone test guide](../../docs/standalone-testing.md) for device setup, build, capture and scoring. When generating a marked ZIP for a three- or nine-direction run, pass `--sustained` to `deep/mark-directions.py`. The default probe watches the three destinations used in the two-key schedule. Diagnostic runs with trace errors retain their files and return `UNMEASURED`.
