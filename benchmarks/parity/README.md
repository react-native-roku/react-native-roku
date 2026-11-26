# Shared layout and paint scene

Copy `App.tsx` and the starter's `src/catalog-cover.png` into a standalone
Roku consumer and a stock React Native reference. Use the same Inter Regular
font bytes, 360 × 660 logical area and viewport origin. Build each with that
platform's ordinary image- and font-asset setup.

Capture the initial settled scene, toggle Change scene, then open the modal.
Keep the raw captures and layout logs with app, package, asset and platform
identities. Compare native bounds and wrapping separately from rendered
colors, stacking, transforms, clipping and focus paint. Compare accessibility
exposure separately from pixel output.

The [physical Roku clipping test](../clipping/README.md) uses paired installer screenshots for preview acceptance.
This scene exercises ordinary app composition across the other cases.
