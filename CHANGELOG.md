# Changelog

## [0.2.0-preview.1]

- Keep item content mounted through internal FlatList window updates. Parent renders, updated data, callbacks and extraData still refresh item content.

- Reuse committed placement branches and submit the affected native nodes on
  stable React trees. Validate inherited presentation settings, geometry and
  font readiness before reuse. The full placement and submission paths handle
  structure changes, cross-node accessibility and unsupported node shapes.
- Add a standalone catalog with packaged artwork, virtualized rows, modal
  navigation, and restoration of the originating card and scroll position.
  Document physical sideloading, debugging and checksum-based rollback.
- Retain SDK memory diagnostics when a counter is a BigInt. The generated
  logger writes those values as exact decimal strings.
- Draw text in explicit tight line boxes while retaining the authored Yoga
  height and wrapped text.
- Keep Back with the presented Modal when an inner dialog isolates accessibility.

- Keep repeated web-runtime cleanup from retiring a later host's ownership,
  while allowing failed cleanup to be retried. Accept native Canvas image
  source types in the Node adapter and check the real decoder in a typed consumer.

- Share one application lifetime between registered and custom mounts, with
  lazy content/setup, fenced callbacks, shared async disposal and independent
  cleanup after failure. Preserve original startup errors and retire web-global
  leases out of order without overwriting another host.
- Add injected, bounded preview font leases and attached-text observations,
  plus the explicit `/testing/node` text HTTP/image-source adapter boundary.
  Independent packed consumers cover lifetime/resource retirement and actual
  local sockets; runtime graphs exclude Node qualification IO.

- Correct collection alignment to use declared item lengths, retire removed
  header geometry, and preserve the actual footer/inset offset across repeated
  End requests. Defer initial indices until newly arrived data is committed.
  Fixed-seed geometry/input replay and minimized packed-consumer cases cover
  these transitions and explicit-command supersession.

- Resolve direct committed ARIA description relationships separately from names,
  with ordered IDs, native-hint fallback, valid empty descriptions, source
  replacement and bounded modal/live publication. Qualify host and independent
  packed behavior; browser hidden-reference semantics remain distinct.

- Keep NativeWind focus-styled TextInput mounting inside its input owner by
  omitting the pinned engine's synthetic no-op press callback for that component.
  Preserve authored events, other component paths and non-Roku transformers.
  Independent Metro Node/Hermes and SDK checks cover the styled field.

- Release failed text-preparation cohorts immediately and fence late raster
  leases without disturbing committed successors. Observe every started font
  and raster promise even when a later synchronous error prevents the normal
  join. Preserve the original error and exercise bounded-cache recovery through
  an independent packed consumer.

- Isolate Image load state by its source/recycling tuple, reject cross-generation
  readiness and stop public callbacks after reentrant retirement. Release Canvas
  Poster/mask decoder references on replacement, clearing and disposal. Packed
  callbacks and actual browser decode/failure/recovery/pixels pass; device
  raster display and ordering remain pending.

- Deliver FlatList separator highlight/unhighlight and leading/trailing prop
  updates through mounted keyed row controllers. Match upstream item metadata,
  shared grid-row controllers and element pass-through; retire saved callbacks
  when a cell leaves. Packed consumers and visible Canvas highlight/restoration
  checks keep the host behavior distinct from device qualification.

- Virtualize single-axis horizontal FlatList lanes with variable widths,
  x-aligned scrolling, boundaries/insets and bounded retirement. Apply keyed
  anchor replacement before reconciling the new window. Packed large-list and
  visible SDK/Canvas fixtures pass; axis changes require remount, horizontal
  grids stay unsupported, and native scrolling/focus remain pending.

- Route modal Back through committed exposure so nested parent effects cannot
  intercept their child's Back. Retain closing/reversal ownership and fence
  retired route portals, animation completions and held input. Physical remote
  and focus behavior remain device-pending.

- Add fixed-height vertical FlatList columns with original item callback indices,
  upstream row-index geometry/scrolling, row styles/separators, keyed lifetime
  rules and complete bounded windows. Reject horizontal grids and column-prop
  changes without remount. Exercise 30,001-item packed consumers and a visible
  SDK/Canvas fixture; native scrolling, focus and performance remain pending.

- Parse ARIA label ID lists with HTML whitespace while retaining explicit native
  alias IDs. Resolve committed label relationships after modal exposure, without
  tree-order-dependent chaining; retain reference order, repeated references,
  missing-source fallback and replacement cleanup. Native speech/traversal and
  the complete HTML accessible-name algorithm remain outside this host subset.

- Preserve primary interruption diagnostics and the caller's SIGTERM handler
  when process cleanup raises; keep failed inputs and propagate cleanup errors.
  Permit explicitly authorized workspace retained ceilings through 80 GiB total,
  preserving the other limits and conservative defaults for unconfigured stores.

- Cancel held JS input and pending background focus when an external editor is
  admitted, preserving a newer reentrant focus attempt. Exercise the real SDK
  revision/close protocol through mounted React inputs with controlled edits,
  queued successors, missing acknowledgements and complete cleanup. Native
  keyboard focus and physical remote delivery remain unqualified.

- Reuse settled Yoga geometry for equivalent React commits and declarative
  opacity-only updates, retaining React effects, current handlers, native writes
  and complete retirement. Changed layout, async fonts, complex inline/raster
  text and explicit native refresh keep the full layout path. The current host
  benchmark accepts explicit consumer inputs and distinguishes structural work
  from uninstrumented Mac timing; firmware performance remains unqualified.

- Persist approved workspace qualification policies with store-bound provenance,
  complete recovery-headroom admission and real inherited-owner validation.
  Other stores retain conservative defaults.

- Preserve authored ARIA current/invalid/popup state, heading levels,
  orientation and role descriptions in committed host semantics and English
  Audio Guide requests. Reconcile focused/live updates, token fallbacks,
  descriptor removal and retirement without exposing secure field values or
  adding native SceneGraph fields. Native traversal/actions/speech still need
  separate qualification.

- Deliver observed editor selections through `TextInput.onSelectionChange`.
  Native dialog carets use text prefixes for UTF-16 conversion; Canvas reports
  actual ranges and caret-only movement. Replays, controlled corrections,
  reentrant callbacks and subscription retirement keep their original request
  lifetime. Native ranges, programmatic selection and firmware behavior remain
  unqualified.

- Publish observed modal text edits through ordinary `TextInput.onChangeText`
  before submission. Reconcile controlled formatting/rejection without reopening,
  suppress programmatic echoes and duplicate accepted-value changes, preserve
  already observed edits on Cancel, and fence reentrant/retired subscriptions.
  SDK and Canvas ports share the optional `TextEntrySession.subscribeText`
  contract; native keyboard and voice behavior remain device-pending.

- Fence animation admission, sampling and publications across reentrant
  cancellation/listener callbacks. A replacement owns one clock, canceled
  samples cannot overwrite it, and nested publications cannot deliver stale
  values afterward. Reconcile derived-value closures after React commits,
  replace conditional subscriptions, preserve inline timing clocks and retire
  mapper work before cancellation callbacks.

- Bound local qualification storage and retire verified temporary environments.
  Count explicitly tracked reuse inputs and stable generated outputs in the
  cumulative budget as well as fresh cohort directories.
  Retire unused per-lane dependency caches after exact-archive proofs, retaining
  source inventories, complete generated trees and the SDK/browser dependency.

- Update active modal text drafts for controlled value changes and imperative
  edits without reopening or fabricating input events. Fence submissions that
  race a native update using editor revisions; keep old ports' missing update
  capability explicit. Native editing behavior remains unqualified.

- Serialize secure strings in a nonempty versioned encrypted envelope, preserving
  empty values and escaped UTF-16 surrogates while retaining legacy credential
  reads and fail-closed native-decryption handling. Native protection and durable
  device behavior remain unqualified.

- Batch offscreen keyed collection rows with explicit limits, intervals and
  interaction-aware cancellation, retaining visible priority and native identity.
  Apply declared initial indices after header/inset measurement and respect the
  minimum eligible visible anchor index. Native scrolling/performance remain
  unqualified.

- Add focused modal `Keyboard.dismiss` and observed `keyboardDidHide`, preserving
  submission ordering and fencing replacement, reentrant focus and retired roots.
  Separate SDK logical cancellation from native close acknowledgement, bound
  missing acknowledgements, and add a reusable Canvas text-entry port to the
  default preview. Keyboard geometry/will/show events and firmware remain outside
  the qualified subset.

- Add object-handle accessibility focus requests, route tag/ref requests to their
  owning root and retain TextInput host aliases through native-ID replacement.
  Preserve visibility, modal, delayed-commit and retired-reference fences.
- Retain explicit View/Text focus admission and announce toggle pressed states
  through the common accessibility semantics on observed focus and updates.

- Add public Metro browser Fast Refresh sessions, static update chunks, original
  patch source maps and a reusable project development server. Preserve safe
  component state, recover from module/render/build errors, reload for unsafe
  lifetimes and retire the runtime with its host. Add a sixth independent packed
  consumer lane; native stateful hot reload remains unqualified.

- Own static raster compilation, embedded URI registration, Metro density/cache
  restoration and SDK image imports in the public build package; use the same
  prepared image bytes in default SDK and browser builders.
- Return source/dependency metadata for the actual Metro output chunks, retain
  configured serializer hooks, and reject invalid JavaScript factories before
  publishing any frontend files.
- Return Metro's complete asset inventory, including density variants and
  asset-plugin metadata, for consumer-owned image compilation and SDK imports.
- Select one React/JSX entry implementation before Metro dependency collection
  in either profile, retaining source offsets and rejecting changed wrappers.
- Qualify fresh Metro CLI setup, types/doctor, actual SDK output and browser
  edit/error/fix/reload/activation through the shared browser journey; include
  both Metro lanes in local full and exact-archive candidate qualification.
- Add `init --bundler=metro`, the optional Metro project/SDK path and public
  `buildRokuMetroModules`; preserve module order/cache and source maps, prepare
  complete Intl data before file-map scanning, and bound SDK code modules.
- Add an optional Metro Babel transformer using the common Hermes-safe Yoga and
  NativeWind preparation, immutable input snapshots and dependency-aware cache
  keys; preserve other platforms and the application's configured transformer.
  Add a separate independent archive/Metro/SDK qualification command.
- Describe production/development compilation profiles in the public project
  builder and environment types, including prepared and SDK build results.
- Retain bounded native video error codes and structured categories; publish
  late details separately from the single failure edge, omit raw diagnostics,
  and fence callbacks from retired content.
- Navigate renderer-owned directional edges using committed transformed bounds,
  preserving explicit semantic links/stops, input ownership and modal fences.
- Resolve explicit logical font families and static normal/italic weights to
  physical assets in the shared metrics, Label and raster resource owner and
  public SDK/browser builders; reject unavailable synthetic styling.
- Add an explicit tabular-number font profile using the font's actual single-glyph
  OpenType substitutions, renamed assets and common label/raster face selection.
- Keep non-touch TV focus independent of pointerEvents and accessibility
  exclusion; retain explicit modal, disabled and display-none input fences.
- Resolve absolute inset, axis and edge aliases with explicit-side precedence,
  percentage geometry and negative overflow in the admitted LTR layout.
- Revalidate delayed focus after modal dismissal against the committed tree;
  reject hidden targets and cancel held presses across visibility/modal changes.
- Add opt-in development root StrictMode replay, fence replayed ref/tag focus
  requests, suppress replay-only modal dismissal, and order nested modal
  isolation by native hierarchy.
- Add ordinary native-ref `focus()` and tag-based accessibility focus requests;
  fence retired refs and delayed measurements/requests across same-ID replacement.
- Keep TextInput handles stable and cancel/fence dialog work on background and
  replacement, including requests made through a retained old handle.
- Normalize primitive accessibility roles, RN/ARIA state/value/label aliases,
  hints and labelled-by text into committed host semantics; announce observed
  focus and live updates through Audio Guide. Retain English/native-review limits.
- Isolate modal accessibility and background input through animated retirement.

Public releases are immutable. Before 1.0, breaking public contracts require a
minor-version change. New adapters and changes to supported versions require
updated compatibility evidence. See [maintenance](docs/maintenance.md).

## [0.2.0]

First developer preview under MIT.

- Replay queued directional input before Select and activate the destination
  after native focus is observed. Imperative focus changes still fence input.
- Reuse solved geometry for fixed-size plain labels that supplied no intrinsic
  measurement. Apply current text normally. Reuse unchanged native fields while
  preserving event subscriptions, child order and activation writes.
- Build an independent app from the included initializer. Release preparation
  seals the exact archive for staging under the `preview` dist-tag.

- Admit native focus before fencing remote input. Refused disabled, hidden or
  modal-isolated requests preserve another control's held press and earlier
  eligible requests. Retire pending fences when their target becomes ineligible,
  preserve reentrant focus ordering and disable native focus outside a modal.

- Capture and bubble observed focus/blur through committed View and ScrollView
  ancestors. Events retain measurable target/currentTarget instances and support
  propagation cancellation. Focus requests remain separate from observations;
  portalled modal focus does not enter background scroll ancestors. Authored empty
  native IDs retain their place in the observation path.
- Lay out wrapped nested Text through measured attributed runs and retained
  one-line native styled labels. Preserve colors/fonts, explicit blank lines,
  authored line heights and tail ellipsis; retire removed lines on resize or
  ancestor removal. Tracked/shadowed mixed paragraphs and device fidelity remain
  outside this qualified subset.

- Add explicit production/development compilation profiles.
  Finite builds now default to production React; previews default to development.
  Development SDK artifacts have independent paths and ZIPs record their profile.
- Execute Modal fade/slide transitions through the shared JavaScript animation
  executor, retaining portal/Back ownership through close and cancelling stale
  completions when reopened or unmounted. Physical presentation remains pending.
- Export the portable text-fetch factory and request/response/redirect types.
  Verified transports can explicitly admit strict redirect refusal; the pinned
  SDK port still rejects it before IO. Preserve cloned policy, strip fragments
  and reject redirect results defensively without treating that as hop proof.
- Add the nonvisual `SceneGraphAudio` resource through `/media`, with explicit
  stream formats, observed state/position/duration/codec/error fields, paused
  seeking and stop-before-removal cleanup. Playback rate and fractional volume
  are outside this native subset; physical decoding remains unqualified.
- Keep small frontends in one build and retire abandoned partition-attempt
  outputs without touching caller-owned files or buffered builds.
- Support collection separators and extraData invalidation while preserving
  retained native rows for clipping hints. Correct immediate scroll-to-end when
  measured tail rows replace estimated geometry.
- Add opt-in English Intl bootstrap for number/currency/compact formatting,
  calendar/time-zone formatting, locale canonicalization and collation through
  pinned FormatJS packages. Configure the polyfill from observed device time zone.
- Load fallback calendar/collation data only when needed, avoiding large table
  decoding on hosts with working native Intl while preserving the full fallback.
- Retire SDK HTTP abort listeners even when firmware never completes a cancelled
  operation or its native abort callback throws; native IO remains device-pending.
- Preserve `Request` credentials/redirect policies through cloning and reject
  unsupported policies and embedded URL credentials before network dispatch.
- Admit `View.collapsable` while preserving native group identity and measurement
  for both values; layout-only view removal is not performed.
- Admit text entry through a scoped native StandardKeyboardDialog port, with
  explicit submit/cancel, masked input, bounded length and late-result fencing.
- Add normalized-history `router.dismissTo`, provider-bound navigation hooks and
  safe retirement when multiple router providers unmount out of order.
- Keep canonical path parameters isolated from conflicting query values and
  snapshot array parameters without retaining mutable caller-owned arrays.

## [0.1.0]

Unpublished experimental beta. No public license has been selected.

- Extract React/SceneGraph rendering, layout, input, services and build adapters.
- Add a standalone generator, AppRegistry entry, SDK build and Canvas development loop.
- Qualify packed independent consumers and their component/library contracts.
- Add compatibility inventory, toolchain checks, release preparation and development cleanup.
- Emit build identity and native ready/memory/error diagnostics from generated SDK startup.
- Add connected cold-start collection with stale-build, runtime-error and foreground guards.
- Honor configured native application/storage names and clean up failed development startup.
- Use explicit pnpm script invocation for the application doctor.
- Keep offline SDK startup independent of missing firmware fetch metadata; fence
  unsupported cancellation, normalize native response headers and reject late aborted bodies.
- Detect atomic configuration replacements through file metadata and watch inputs
  before cold compilation so startup edits cannot be missed.

Hardware qualification, complete upstream API coverage, full Metro-to-SDK
integration and state-preserving Fast Refresh remain open.
