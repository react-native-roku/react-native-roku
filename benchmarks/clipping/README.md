# Rounded poster clipping on a Roku

This test uses one developer-enabled Roku and its built-in developer installer screenshots. A Mac or Linux development host runs the build and scorer. Use Node and pnpm from the repository, Python 3, ffmpeg/ffprobe, a 1920 × 1080 Roku UI capture, and the device setup in [standalone testing](../../docs/standalone-testing.md). Supply the ZIP for the currently installed idle developer channel as the rollback image. The lab runner handles the device lease, installation and verified restoration.

From the repository root, use a new directory for each build and capture. `ARCHIVE` is the exact npm tarball under review. For release qualification use the sealed archive.

```sh
node benchmarks/consumers/prepare.mjs "$ARCHIVE" "$RUN/clipping-build" clipping
node benchmarks/navigation/lab.mjs clipping react "$RUN/clipping-build/fixture.zip" "$ROLLBACK_ZIP" "$RUN/clipping-device" --restore-dev
node benchmarks/clipping/verify.mjs "$ARCHIVE" "$RUN/clipping-build" "$RUN/clipping-device" > "$RUN/clipping-receipt.json"
```

The fixture renders the shared core UI scene first with rounded clipping, then with a square poster. Five Select presses advance through three states for each shape. The same installed ZIP, poster, coordinates and SDK configuration serve both halves. The runner captures two original installer frames per state and brackets each with native focus, mode and state observations. It retains the images, tree observations and measurements locally. Failed attempts require a fresh output directory.

Four fixed corner coordinates avoid the adjacent focus stroke. In each frame, ten independent reference patches verify the background, artwork, edges, overlay, wrapping, opacity and mode marker. Each reference uses a 5 × 5 channel median and allows 20 color levels. For every corner, the square control must show the expected side of the artwork. Its largest RGB channel difference from the background must reach 110 levels, and its distance from the interior artwork must be at most 45% of the artwork-to-background distance. A rounded corner passes within one quarter of the measured control separation from its background, capped at 40 levels. A corner within one quarter of the separation from the square control fails. Intermediate colors and invalid references are inconclusive. All 24 paired observations must pass.

Verification reopens the archived images, checks their hashes and bracketing observations, and recomputes the score. The compact staging receipt binds these measurements to the fixture ZIP and npm tarball. The protected release workflow checks the submitted measurements against the reviewed tarball. The raw device evidence stays with the reviewer. A recorded screenshot tests the settled installer image. Panel scanout and first-visible-highlight latency remain separate measurements.
