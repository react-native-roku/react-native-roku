# Sustained navigation on the Roku Ultra

## Conclusions

1. **Sustained input landed in 4/4 candidate launches and 0/4 controls.** The marked launch observed all nine native focus changes and one Card 64 activation. Back restored the same focus, bounds and 2520 px offset. 7 intermediate swaps lacked a state-qualified timing endpoint.
2. **The comparable shelf gap moved from 15.56 ms to 15.29 ms at the median and from 20.12 ms to 18.47 ms at p95.** The gain did not exceed same-build variation across both orders. Keep the correctness fix and drop the Yoga trial.
3. **Target React work after the native focus callback.** It took a median 13.91 ms through renderer commit entry in the separate shelf trace. Layout geometry accounted for a median 0.68 ms.

The signed navigation change is `d4f751b6f6365e06a40ceb1610ad3667872c47f4` on `renderer/sustained-navigation`. It holds requests open for the full 250 ms native-observation interval and keeps one adjacent row mounted on each side of a moving, overlapping FlatList window when the overscan budget allows it. Disabled-state checks, refs, callbacks, Back handling and native focus acknowledgement use their existing paths. Existing apps use the fix through their default build.

## Why the baseline loses input

Four counterbalanced launch pairs used the same Ultra 4850X, firmware 16.0.4 build 853, 1080p UI, SDK 2.19.1, Inter font and unchanged 24-card consumer. There were two React-first and two Solid-first pairs. The reference wraps the full title. The scores use the first completed SDK swap whose render began after both linked native applies. Separate marked runs verified that the second apply is the first one with native focus, both highlight colors, the complete wrapped title and the required scroll position for all 30 moves. Six moves scroll and 24 are stationary in each launch. Perfetto and replay evidence come from the device clock and the native tree respectively.

The four matched baseline runs and the initial reproduction ended on Card 48. In the marked phase trace, the first row replacement spent 307 ms in Yoga out of a 404 ms renderer commit. The second and third keys reached JS after that work. The fourth key queued behind Card 36, then requested Card 44 from Card 40 upon replay. Its 250 ms focus timer fired 0.4 ms after submission. The next key therefore started from Card 40 and requested Card 44 again. Later keys reached the renderer before the next row was mounted.

| Down | Intended card | SDK delivery after the first app key (ms) | Observed renderer action                                   |
| ---- | ------------: | ----------------------------------------: | ---------------------------------------------------------- |
| 1    |            32 |                                       0.0 | Requested and observed Card 32                             |
| 2    |            36 |                                     604.9 | Requested and observed Card 36                             |
| 3    |            40 |                                     606.9 | Queued, then requested and observed Card 40                |
| 4    |            44 |                                     607.2 | Queued, requested Card 44 and expired before observation   |
| 5    |            48 |                                    1180.0 | Requested Card 44 from Card 40 again                       |
| 6    |            52 |                                    1183.8 | Queued, then requested and observed Card 48                |
| 7    |            56 |                                    1264.4 | Queued, then found no eligible mounted target from Card 48 |
| 8    |            60 |                                    1640.7 | Found no eligible mounted target from Card 48              |
| 9    |            64 |                                    1641.9 | Found no eligible mounted target from Card 48              |

The original unpaced holdout also failed. Its seventh Down reached SDK delivery in 1.13 ms, with no linked focus submission. The last matching snapshot contained Route 7 at the trailing edge and had no Route 8. A structural submission began 175 ms after that key. Route 8 was mounted in the eventual tree, where Route 7 was still focused. This shares the missing adjacent target observed later in the deep run. The premature timeout at key four accounts for the deep route's earlier divergence. A marked holdout replay reached Route 8 at the unpaced setting, so it supplies diagnostic context separately from the failing exact run.

The baseline rebuilds a Yoga tree for structural changes. It can keep local rectangles for certain fixed boxes with leaf-only children. The first traced window replacement reused 40 such boxes and still built 83 Yoga nodes. A disposable trial retained Yoga's own nodes and matched fresh Yoga rectangles across wrapping, text and line-limit changes, resize, insertion, removal and reorder. The host replacement allocated 14 nodes with the trial and 53 with the baseline. One marked window replacement spent about 61 ms between cached-tree preparation and the end of Yoga calculation. The corresponding interval after fresh tree construction on the baseline took about 231 ms. The unmarked trial reached Card 60 and missed Route 8. Combining the trial with the input fixes reached Card 56 on its first nine-key run. Those ZIPs and traces are included as experiments. The signed archive contains the smaller navigation change.

## Scored shelf comparison

| Cohort   | Build                | Movement   | Moves | Median (ms) | p95 (ms) | Worst (ms) |
| -------- | -------------------- | ---------- | ----: | ----------: | -------: | ---------: |
| Baseline | Default React        | Overall    |   120 |       28.86 |    38.36 |      41.84 |
| Baseline | Default React        | Stationary |    96 |       28.44 |    39.69 |      41.84 |
| Baseline | Default React        | Scrolling  |    24 |       33.95 |    37.65 |      38.08 |
| Baseline | Full-title Solid     | Overall    |   120 |       13.30 |    18.24 |      20.29 |
| Baseline | Full-title Solid     | Stationary |    96 |       13.65 |    18.43 |      20.29 |
| Baseline | Full-title Solid     | Scrolling  |    24 |       12.99 |    17.13 |      19.11 |
| Followup | Default React        | Overall    |   120 |       29.28 |    38.07 |      41.82 |
| Followup | Default React        | Stationary |    96 |       28.79 |    38.07 |      41.82 |
| Followup | Default React        | Scrolling  |    24 |       30.71 |    38.12 |      39.10 |
| Followup | Navigation candidate | Overall    |   120 |       29.05 |    38.02 |      40.78 |
| Followup | Navigation candidate | Stationary |    96 |       28.93 |    37.95 |      40.78 |
| Followup | Navigation candidate | Scrolling  |    24 |       30.89 |    38.44 |      38.57 |
| Followup | Full-title Solid     | Overall    |   120 |       13.76 |    19.55 |      21.95 |
| Followup | Full-title Solid     | Stationary |    96 |       14.54 |    19.76 |      21.95 |
| Followup | Full-title Solid     | Scrolling  |    24 |       13.16 |    18.90 |      19.67 |

The scored launches had zero failed inputs, unattempted inputs or missing qualified endpoints. Stationary and scrolling denominators remained fixed. The p95 uses nearest rank across the reported moves. The launch is the repeat unit for the order and variation checks.

Baseline same-build launch median ranges were 2.04 ms for React and 2.31 ms for Solid. The largest median absolute matched-move differences were 4.57 ms and 1.68 ms respectively. In the repeat triples, matched candidate savings against concurrent baseline React were +0.26, -1.01, -0.46, -0.27 ms across the four blocks. The pooled fraction of the original gap closed was +1.8% at the median and +8.2% at p95. The per-launch results in [results.json](results.json) include each cohort and comparison order.

## Packed candidate breadth

- **Unpaced holdout pilot.** 16/16 native state checks passed.
- **Unpaced holdout repeat.** 16/16 native state checks passed.
- **Resize during scroll.** 16/16 native state checks passed. The separate viewport fixture recorded 720 px before the move and 560 px while scrolled. The initial launch failed before replay. The retry ran after a verified device reboot.
- **Rapid Down, reversal and paced control.** 24/24 activation and Back checks passed. Strict trace status was PASS.
- **Third Down and immediate Select.** Terminal state passed. Strict trace status was PASS.
- **Missed native focus notification.** The marked copy withheld one positive focus event. Native readback restored focus and the replay verified activation, Back and the following move.
- **Image load, error and remount.** The packaged image loaded, the missing image reported an error, and the packaged image loaded after remount.
- **Modal and Back focus restoration.** Back and Select each dismissed the modal and restored focus to the edit control.
- **Cold launch.** The first usable-input state arrived at 8644 ms on control and 8769 ms on candidate. Each was a cold host-clock replay with a correct initial focus and a Right that skipped the disabled card. This single comparison has no repeatability estimate.
- **Independent workload timing.** The paced holdout results preserve their state checks and separate field attribution. paced-holdout-retry-01-control 35.71 ms. paced-holdout-retry-02-candidate 31.58 ms. paced-holdout-retry-03-candidate 34.68 ms. paced-holdout-retry-04-control 32.10 ms. The median advantage changed sign between the two launch orders.
- **Settled pixels.** Captured both builds at 5/5 matching holdout stages. The compared regions contained 0 differing pixels. The detail crops cover both title widths.
- **Navigation soak, control.** 9/9 rounds and 216 successful inputs. The 30-second idle sample had 175.2 MiB RSS, 28 mounted cards and 175 observed nodes. Device SceneGraph nodes went from 180 at the initial checkpoint to 1223 after idle.
- **Navigation soak, candidate.** 9/9 rounds and 216 successful inputs. The 30-second idle sample had 173.5 MiB RSS, 28 mounted cards and 175 observed nodes. Device SceneGraph nodes went from 180 at the initial checkpoint to 1267 after idle.
- **Resource trend.** Both builds grew in RSS and total SceneGraph nodes over the soak. The idle mounted counts agreed. These single runs do not establish a memory improvement or regression.

Both new host regressions failed on the starting revision and passed on the candidate. The host checks passed 631 renderer tests, 110 build tests, 14 Python and 14 Node navigation tests, both TypeScript configurations, package and compatibility checks, independence and formatting.

First visible highlight, compositor frame contents and physical screen-reader output remain unmeasured. The exact six-lane seal was refused at storage admission. Available capacity was 12.574 GiB against the unchanged 32 GiB startup requirement, with no separate provisioned worker or volume available. The receipt and independent results were preserved.

## Reproduce

The baseline archive is `a304bfbaed6c85cb680012d18295e25e0ab5929d677fdbe46671930235c2869e`. The original frozen standalone ZIPs were built from `04e21bdec15b075fd1e233141332a092679cbba385767af9ed2869c72b3782b9`. The two archives differ only in `package/docs/maintenance.md`. The compiled deep and holdout programs matched the rebuilds from the requested archive after normalizing their build directories. In separate post-reboot runs from the rebuilt ZIPs, the deep baseline stopped at Card 56 and the unpaced holdout passed 16/16 checks. These runs were outside the counterbalanced cohorts. The signed candidate repacked byte-for-byte as `6eb59875d6d5df01097214037902170df531b998cf09a718ca4fd7fc23f7af57`. Exact ZIP hashes and per-launch scores are in [results.json](results.json).

Follow the [standalone test guide](../../../../docs/standalone-testing.md) to set up the device. Use the configured shared lease, the authorized developer-login configuration and an exact rollback installer ZIP. The runner verifies installer digest and bytes before touching the channel and again after restoring. Set `TRACE_PROCESSOR` to the public Perfetto executable and `DEVICE` to the configured Ultra host.

```sh
RUN="$(mktemp -d)"
export ROKU_BENCHMARK_HOST="$DEVICE"
export ROKU_LEASE_DIR="$SHARED_LEASE"
export ROKU_BENCHMARK_OUTPUT_MODE="1080p UI reported by device-info"

git verify-commit d4f751b6f6365e06a40ceb1610ad3667872c47f4
pnpm pack --out "$RUN/candidate.tgz"
shasum -a 256 "$RUN/candidate.tgz" "$ROLLBACK_ZIP"
node benchmarks/consumers/prepare.mjs "$RUN/candidate.tgz" "$RUN/catalog" catalog
ROKU_SHELF_WORKLOAD=catalog node benchmarks/shelf/prepare.mjs "$RUN/candidate.tgz" "$RUN/shelf" react
ROKU_SHELF_WORKLOAD=catalog node benchmarks/shelf/prepare.mjs "$RUN/candidate.tgz" "$RUN/reference" solid-full
node benchmarks/navigation/holdout/prepare.mjs "$RUN/candidate.tgz" "$RUN/holdout" react

node benchmarks/navigation/lab.mjs deep-long react "$RUN/catalog/fixture.zip" "$ROLLBACK_ZIP" "$RUN/deep" --restore-dev --rk "$PWD/node_modules/.bin/rk" --processor "$TRACE_PROCESSOR"
python3 benchmarks/navigation/deep/mark-directions.py "$RUN/catalog/fixture.zip" "$RUN/catalog-marked.zip" --sustained
node benchmarks/navigation/lab.mjs deep-long-fields react "$RUN/catalog-marked.zip" "$ROLLBACK_ZIP" "$RUN/deep-marked" --restore-dev --rk "$PWD/node_modules/.bin/rk" --processor "$TRACE_PROCESSOR"
node benchmarks/navigation/lab.mjs holdout react "$RUN/holdout/react.zip" "$ROLLBACK_ZIP" "$RUN/holdout-unpaced" --restore-dev
node benchmarks/navigation/lab.mjs warm react "$RUN/shelf/react.zip" "$ROLLBACK_ZIP" "$RUN/shelf-react" --restore-dev --rk "$PWD/node_modules/.bin/rk" --processor "$TRACE_PROCESSOR"
node benchmarks/navigation/lab.mjs warm solid "$RUN/reference/solid-full.zip" "$ROLLBACK_ZIP" "$RUN/shelf-solid" --restore-dev --rk "$PWD/node_modules/.bin/rk" --processor "$TRACE_PROCESSOR"

python3 benchmarks/navigation/suite.py post-apply "$RUN/shelf-react/journey"
node benchmarks/navigation/lab.mjs catalog-cold react "$RUN/catalog/fixture.zip" "$ROLLBACK_ZIP" "$RUN/cold" --restore-dev
ROKU_CATALOG_CHECKPOINT_EVERY=3 ROKU_CATALOG_IDLE_SAMPLE_MS=30000 node benchmarks/navigation/lab.mjs catalog react "$RUN/catalog/fixture.zip" "$ROLLBACK_ZIP" "$RUN/soak" --restore-dev --rounds 9
```

The results file records the launch order and individual scores. The offline scorer consumes the original attempts and retains missing samples and failed replays. The initial shelf attempts that lacked the required display label were excluded before scoring any inputs. The later unpaced diagnostic invoked the paced scorer for trace extraction. That status is separate from its replay result. The first resize launch and three initial paced holdout attempts failed startup before sending inputs. They were preserved separately from the post-reboot runs. A candidate route can satisfy the terminal state and single-activation requirements while some intermediate swaps lack the native state or flow evidence the strict timing scorer requires.

The final rollback returned to the original developer channel, matched the input ZIP, verified playback closed and released the shared lease.
