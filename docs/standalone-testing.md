# Standalone testing

A maintainer needs the source repository, a supported Node installation, pinned pnpm and public registry access. Hardware work additionally needs a developer-enabled Roku. Tests use package-owned screens, assets, routes, expected results and scoring code. The release archive contains the public initializer. The benchmark suite lives in the source distribution.

## Clean host and package

Run these from a fresh clone. Choose a new directory outside the checkout for each experiment.

```sh
pnpm install --frozen-lockfile --registry=https://registry.npmjs.org
pnpm check:independence
pnpm test:navigation
node scripts/check-independence.mjs --coverage > /tmp/roku-coverage.json
pnpm check:fast
pnpm pack --out "$RUN/runtime.tgz"
node benchmarks/consumers/prepare.mjs "$RUN/runtime.tgz" "$RUN/catalog" catalog
node benchmarks/consumers/prepare.mjs "$RUN/runtime.tgz" "$RUN/images" images
node benchmarks/consumers/prepare.mjs "$RUN/runtime.tgz" "$RUN/settings" settings
```

Set `RUN` to an existing, private experiment directory first. Each consumer runs the initializer from the selected archive, installs its pinned dependency graph, typechecks, and builds a ZIP. Its input receipt records the archive, ZIP, entry and lock hashes. To compare with full-title Solid, use `ROKU_SHELF_WORKLOAD=catalog node benchmarks/shelf/prepare.mjs "$RUN/runtime.tgz" "$RUN/shelf" solid-full`. The frozen 24-card React and 48-row image holdout have their own recipes in [navigation](https://github.com/react-native-roku/react-native-roku/blob/HEAD/benchmarks/navigation/README.md). Use ordinary default rendering for the primary React cohort.

The [Solid scorecard and measured example](https://github.com/react-native-roku/react-native-roku/blob/HEAD/benchmarks/navigation/README.md#reproduce-the-full-title-solid-scorecard) document the endpoint, collection design and raw-trace verification. Run `pnpm test:navigation` for offline scorer and device-protocol regressions. This entry point runs independently of storage admission for the exact-package seal.

## Physical runs

Set `ROKU_BENCHMARK_HOST` to the device address and `ROKU_LEASE_DIR` to the lock directory shared by **all** jobs using that device. Configure the public SDK developer login locally or set `ROKU_DEV_PASSWORD`. The runner requires an idle channel whose installed digest and byte count match your rollback ZIP. On a new dedicated device, install your own public starter as the rollback channel once. Supply its ZIP on subsequent runs. The runner locks the device by serial, checks the installed artifact, launches the requested fixture, restores the original, and verifies media is idle. A failed restoration retains the lock for recovery. Recheck the installed digest and idle state before clearing an abandoned lock. Keep raw receipts and credentials out of Git.

```sh
node benchmarks/navigation/lab.mjs images react "$RUN/images/fixture.zip" "$ROLLBACK_ZIP" "$RUN/gallery-device"
node benchmarks/navigation/lab.mjs settings react "$RUN/settings/fixture.zip" "$ROLLBACK_ZIP" "$RUN/settings-device"
node benchmarks/navigation/lab.mjs settings-storage react "$RUN/settings/fixture.zip" "$ROLLBACK_ZIP" "$RUN/settings-storage"
node benchmarks/navigation/lab.mjs deep-long react "$RUN/catalog/fixture.zip" "$ROLLBACK_ZIP" "$RUN/sustained" --rk "$PWD/node_modules/.bin/rk" --processor "$TRACE_PROCESSOR"
```

Set `TRACE_PROCESSOR` to an executable Perfetto trace processor. `--restore-dev` requests the verified rollback channel in the foreground even when the run starts on Home. `--reboot-before` requests a single SDK reboot under the same lease before fixture installation. `ROKU_STARTUP_DIAGNOSTICS=1` collects startup console diagnostics separately. The suite can also replay on a fixture installed by a different lab operator using its authenticated installer receipt. Output directories must be new.

The `settings-storage` journey reads the existing fixture preference, changes it through a focused control, waits for the storage write, terminates the dev channel, verifies that it left the foreground, and relaunches it. It requires the changed value and restored default focus. It then restores the original value and verifies it through a second cold launch. This uses the fixture's own registry namespace. Text entry and spoken accessibility remain separate checks.

Run `deep-window` for mounted row geometry, `deep-second` for rapid Down, reversal and paced control, `deep-triple` for a following Select and `deep-long` for nine directions. The sustained route checks Card 64 before Select, opens its Detail and verifies restored focus, scroll offset and mounted rows after Back. A mismatch fails the run. Use `python3 benchmarks/navigation/deep/mark-directions.py INPUT.zip MARKED.zip` for callback and field attribution, and the matching scenario with `-fields`. Use `python3 benchmarks/navigation/deep/mark-window.py` for the structural window trace. Keep marked and unmarked results separate. For saved traces use `suite.py extract deep-long RUN --processor EXECUTABLE` in a fresh copy containing the trace, then `python3 benchmarks/navigation/deep/directions.py RUN --output SCORE.json` with the corresponding replay. Use `python3 benchmarks/navigation/deep/window.py RUN --marked-zip-proof PROOF.json` or `--attribution MARKED_SCORE.json` for structural window timing.

## Coverage and acceptance

The compatibility registry maps supported APIs to contracts and checked-in tests. The coverage command expands those references per API. Scope descriptions distinguish host behavior from physical support. A test path is a way to reproduce evidence. A release claim requires a result for the selected artifact and target.

| Area                                                | Package-owned exercises                                                                                                                 | Additional physical evidence                                                                                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-pad, focus, lists and scroll                      | Shelf, full-title Solid, cross-row and reversal bursts, missed focus, deep routes, Back and residency soak                              | Capture dispatch, apply and eligible swap per key. Require the correct destination, single activation and restored offset.                                                          |
| Text, images and rendering                          | Wrapping titles, resize, image holdout, packaged gallery load, missing image, removal and remount                                       | Score settled pixel crops, field lifetimes and clip bounds. Use the paired installer screenshot test for rounded clipping. First-visible latency is a separate display measurement. |
| Input, overlays and accessibility                   | Settings modal, editable field, preferred focus, accessible labels, dismissal and focus return, host text-input and accessibility tests | Enter and submit text with a physical keyboard/dialog and verify spoken focus separately.                                                                                           |
| Animation, surfaces, navigation, services and media | Registry-linked tests, public composed UI and SDK fixtures                                                                              | Track supported device/firmware observations individually, including animation pacing, playback and speech.                                                                         |
| Developer experience                                | Packed initializer, clean builds, both bundlers, reload and public compatibility checks                                                 | Cold launch, lower-tier hardware, memory, long sessions and failure recovery require their own receipts.                                                                            |

Benchmark changes against the same fixture, command schedule, SDK and display configuration. Run A/A for noise and fresh launches in both A/B orders. Compare matched steps and per-launch medians, p95 and worst. Record failures and missing endpoints in the denominator. Promote an optimization only after correctness, tail latency and an independent workload agree. A completed SDK swap is a device-clock endpoint. A visible frame needs separate display evidence.

Run `pnpm check` or the manual full CI workflow for the exact six-lane seal. It requires the documented storage admission. If storage is short, point `RNR_QUALIFICATION_STORAGE_ROOT` at a sufficiently provisioned canonical store under the documented volume rules, use a clean worker with sufficient disk, or run the documented storage maintenance. Preserve failed runs and continue independent checks. Report seal status separately.
