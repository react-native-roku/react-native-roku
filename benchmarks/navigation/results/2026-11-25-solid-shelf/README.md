# React Native and Solid on the frozen Roku shelf

Archived measurement from November 25, 2026. [Per-move evidence](scorecard.json) and [collection instructions](../../README.md#reproduce-the-full-title-solid-scorecard).

Roku 4850X, firmware 16.0.4 build 853, 1080p UI. SDK 2.19.1. Input spacing setting 200 ms.

Device key-down to completed SDK swap of a render begun after the required native updates. The independent marked runs check both highlights, the full title, native focus and scroll position.

240 inputs scored across 8 fresh launches. Excluded attempts listed in the manifest: 0. Every scored move had a matching settled native tree.

| Pair | Framework | Moves | Median (ms) |   p95 | Worst | Stationary median | Scrolling median |
| ---: | --------- | ----: | ----------: | ----: | ----: | ----------------: | ---------------: |
|    1 | react     |    30 |       29.21 | 37.79 | 38.02 |             29.46 |            28.43 |
|    1 | solid     |    30 |       14.74 | 19.67 | 19.76 |             15.04 |            11.96 |
|    2 | solid     |    30 |       14.16 | 19.55 | 20.36 |             14.85 |            13.22 |
|    2 | react     |    30 |       28.96 | 38.57 | 40.78 |             28.61 |            31.78 |
|    3 | solid     |    30 |       11.74 | 20.34 | 21.95 |             11.74 |            12.81 |
|    3 | react     |    30 |       28.82 | 37.95 | 38.56 |             28.69 |            31.23 |
|    4 | react     |    30 |       29.52 | 39.09 | 39.44 |             29.05 |            33.11 |
|    4 | solid     |    30 |       14.06 | 18.76 | 19.83 |             13.84 |            14.66 |

Positive gaps mean React took longer. Median gaps compare matched moves. The p95 gap compares the two launch percentiles.

| Pair | Launch order     | Median gap (ms) | p95 gap (ms) |
| ---: | ---------------- | --------------: | -----------: |
|    1 | react then solid |           16.25 |        18.13 |
|    2 | solid then react |           16.41 |        19.03 |
|    3 | solid then react |           17.26 |        17.61 |
|    4 | react then solid |           18.09 |        20.32 |

Largest same-build median absolute matched difference: React 4.24 ms, Solid 2.71 ms. Launches are the repeat unit.

First visible highlight and compositor pixels are unmeasured. The image-backed holdout, sustained input, memory and other Roku models require separate results.

React package SHA-256 `6eb59875d6d5df01097214037902170df531b998cf09a718ca4fd7fc23f7af57`

React ZIP SHA-256 `7642387f5aec3f990a08989770a300115a847d702d6ac70432454fc7d69931fb`

Solid ZIP SHA-256 `4085057050dd571746c2d76db13e4847badbcbb5b52f3c478199964ae1dfa300`
