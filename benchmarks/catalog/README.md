# Catalog navigation replay

Generate an independent app from the selected archive using the public
initializer. Set its entry to `src/Catalog.tsx`, build the SDK ZIP, and retain
the package and ZIP SHA-256 hashes. The published example supplies the scene
and image. The replay checks the current installed ZIP by MD5 and byte count.

Use a leased Roku with a verified rollback ZIP. Install the catalog ZIP and
save the authenticated installer checksum and byte count as a text receipt.
Start the app fresh and wait for Card 1 to receive native focus.

```sh
ROKU_BENCHMARK_HOST=your-roku-host node benchmarks/catalog/replay.mjs \
  /absolute/catalog.zip /absolute/installer-receipt.txt /absolute/new-output 1
```

The route checks grid edges, a disabled card, mounted-window size, a scrolled
Detail → Back return, and modal focus isolation. It records the target card's
native bounds before and after restoration. Increase the final argument for
a mixed-navigation soak. A soak records the settled scene, mounted cards,
observable tree nodes, all-node and unparented SceneGraph counts, channel
resident bytes when reported, and host observation timings every 25 rounds
and at the end. Keep listener lifetime assertions in the host regression
tests. Record a fresh preflight
and restore the known development channel before releasing the lease.

The reported interval is host command to first matching tree observation.
Use it to diagnose navigation and restoration. Device-clock render and swap
timing use separate Perfetto traces.

## Preferred focus after row remount

Set `ROKU_CATALOG_VERIFY_FOCUS_RETENTION=1` and request two rounds.
The first round verifies Detail → Back and the eventual retirement of the
restored card outside the window. In the second round, the runner waits
with Card 16 selected until the former preferred Card 32 remounts.
Card 16 must remain focused through that idle interval, and the next
Down must select Card 20. Use the packed initializer's catalog to exercise
the application's preferred-focus lifetime.

## Focused row removal

Copy `Removal.tsx` into the independent app and build it as the entry.
Hold Select on the first focused route to remove it. Check that the next
row receives focus and the quick-selection count stays zero after release.
A fresh Select increments it once. This exercises key release across a
virtualized row's retirement and an application-owned focus handoff.

## Six shelves

Build `Shelves.tsx` in the same isolated consumer. Start at New routes, Route
1, and send Right, Right, Down, Right, Down, Down, Down, Down, Down, Left,
Up. The route checks six shelves with 12 cards each, along with the bottom
edge and vertical alignment between rows. Verify that High passes, Route 3
has native focus and that one Select increments Opened to 1.
