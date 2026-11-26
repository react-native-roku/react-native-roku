# Compatibility contract

This is an experimental platform package, not a general claim of React Native
or third-party library compatibility. Supported versions are pinned in the
manifest and lockfile. The adapter inventory is exported from `/build`; it is
the source of truth for consumer bundlers and evidence tools.

The implemented surface includes View/Text/Pressable, images and gradients,
scroll and input mechanics, nested text, Yoga layout, native measurements,
focus/input transport, accessibility observations, bounded animation, SVG
geometry/raster adapters, navigation, device services, network/web primitives,
and SceneGraph video execution. Reanimated/worklets and Expo adapters implement
bounded subsets. Worklets run on the JavaScript host; this is not the upstream
native UI thread architecture. Private React Native imports are unsupported.
Unsupported operations should fail explicitly instead of implying success.

Host tests prove JavaScript contracts and cleanup through a recording or Canvas
SceneGraph. They cannot prove firmware rendering, measured native font parity,
remote timing, native networking/storage protection, codecs, DRM, audio routing,
subtitle execution, or sustained device memory/performance. The upstream Hermes
CLI in the test cohort lacks native Intl; the opt-in English profile now
passes its expanded formatting, collation and date-method host contracts.
Actual Roku hardware qualification is required before calling this production
ready. RSG 2.0 beta availability and channel distribution are separate gates.

`aria-describedby` resolves an ordered HTML-whitespace ID list from the same
direct committed source snapshot as label relationships. It supplies the
control's spoken hint without changing its name. Missing references fall back
to `accessibilityHint`; an existing empty description suppresses that fallback.
Committed source changes, replacement, retirement, modal exposure and live
updates use the same bounded publication owner. Description relationships do
not recursively follow each other's hints, so cycles remain finite.

This exposed-host profile excludes hidden/modal-background description sources.
HTML can use explicitly referenced hidden sources, as observed independently in
Chromium for the input fixture. This is a bounded
[ARIA description relationship](https://www.w3.org/TR/wai-aria-1.2/#aria-describedby)
contract, not the complete HTML name/description algorithm or native assistive
traversal/speech qualification.

The preview requires a physical Roku to pass the paired rounded-poster check
using the device's built-in developer installer screenshots. It compares every
corner with the same poster rendered square, verifies the visible state and
records the model and firmware. The older JPEG probe measured 14 against a
tolerance of 12. A known-good frame can exceed that tolerance during JPEG
encoding. See [qualification](qualification.md#physical-roku-clipping).
First visible highlight remains unmeasured.

The 360 × 660 parity scene used the same Inter Regular file on the Ultra
and stock React Native 0.86.2 on iOS. Six authored Yoga frames matched.
Roku wrapped one more word onto the second line of the long title and kept
two more characters before the single-line ellipsis. Check the visible text
on the target when the last word or character matters.

## Motion

The JS animation runner fences reentrant request replacement, cancellation,
user-easing samples and subscriber publications. A cancellation callback can
admit a newer animation without leaving an orphaned clock; an obsolete sample
or publication cannot overwrite the replacement. Host and independent-consumer
contracts cover those lifetimes. Native timing/smoothness remain unqualified.

Derived values reconcile captured React props and conditional shared reads after
commits. Equivalent timing/composition requests retain their clock while easing
and completion callbacks use the latest committed closure. Changed targets,
durations or composition admit a replacement. Retirement removes subscriptions
before canceling work. These are JS host semantics, including effect replay;
they do not establish upstream UI-thread scheduling or native presentation parity.

## Static raster assets

Project builds prepare static PNG/JPEG and convert WebP to PNG. Metro preserves
logical dimensions while selecting a build-time density, and restores images
after transform-cache hits. Embedded data URI values remain authored strings;
the image adapter resolves their registered packaged URI. Animated images,
adaptive density changes and other embedded formats remain unsupported. SDK
packaging and host observations do not certify firmware pixels or decoded media.

## Optional Intl bootstrap

`react-native-roku/intl/en` installs missing Intl implementations through pinned
FormatJS packages, with explicit English number/calendar data, collation data and
the golden time-zone set. Import this profile before application formatting and
call `configureIntlTimeZone(observedTimeZone)`. Working native constructors and
their system time zone remain in place. The polyfill requires a nonempty, valid
observed zone; an unknown zone must not silently become UTC. The SDK host obtains
the raw zone through its DeviceInfo task before mounting. A few documented Roku
geographic names are normalized; other names use the formatter's IANA validation.

This profile has a material bundle cost, especially collation data. It is opt-in
and does not claim all locales, calendars, or native timezone behavior. Host
contracts include currency/compact numbers, numeric sorting, accent-insensitive
comparison, Date locale methods and a daylight-saving transition. Device locale
and timezone observations still need firmware review. Native-independent tests
use explicit fixture zones. Other locale profiles can be added with their own
data and qualification rather than substituting English for a requested locale.

Every newly used API needs a contract or an explicit unsupported decision.

Application registration, generated SDK mechanics and the Canvas watch/reload
workflow are qualified through independent packed installs. AppRegistry exposes
registration/query helpers, not the complete upstream API. The Metro adapter is
a target-scoped resolver and dependency transformer. The optional Metro project
builder retains the same component/registry and native generation boundary,
extracts complete Intl tables and bounds modules for SDK transformation. Its
packed consumer qualification covers the generated Metro graph. Device live reload requires physical testing. Metro browser development adds stateful React Refresh through
one retained module cache, with full reload for unsafe lifetime/configuration
changes. Its installed-consumer qualification is distinct from native stateful
hot reload. Existing React Native and TVOS
targets retain their own resolution and runtime.

## Modal presentation

`Modal` preserves React context through a viewport portal and escapes ancestor
clipping. `animationType` accepts `none`, `fade` and `slide`. Fade changes opacity;
slide translates the viewport vertically. Animated transitions use the existing
JavaScript executor over 300 ms, retain the portal and Back ownership until close
finishes, and cancel retired completions on reversal or unmount. `onShow` follows
opening completion; `onDismiss` follows portal retirement. No-animation closure
remains immediate. Native animation smoothness, physical focus and presentation
timing require device review; this is not a native-thread performance claim.

Back ownership follows the top committed modal's exposure, independently of
parent/child effect registration order. Lower or retired portals cannot consume
Back ahead of that modal. Closing transitions retain ownership, including when
an opening reversal is interrupted again. Mounted route replacement/return tests
retain held-input and queued-completion cleanup; the independent packed consumer
checks nested Back and complete retirement. A fully hidden modal receives a new
presentation order when reopened, placing it above siblings that remained open.
Component mount order does not decide that later presentation. Reversing an
unfinished close preserves its existing order, keeping a retained nested modal
above its parent. Two fixed-seed schedules exercise 96 sibling transitions each;
actual Chromium checks the pinned web manager's Escape routing separately.
The packed SDK/Canvas fixture verifies visible sibling layering and Back cleanup.
These are host lifetimes; native modal ordering remains device-pending.

## Video error observations

`SceneGraphVideo` observes native `errorCode` and structured `errorInfo` as well
as playback state. Its snapshot retains bounded integer codes and the documented
`http`, `drm`, `mediaerror` and `mediaplayer` categories. Raw native messages,
debug strings and module/source names are excluded. A repeated error state does
not emit another failure; fields arriving later publish `error-details` instead
of another recovery edge. Source replacement and retirement fence all callbacks.
Host ordering fixtures do not establish firmware decoding or recovery behavior.
See the [native Video fields](https://developer.roku.com/dev/docs/video) and
[SDK Video events](https://developer.roku.com/dev/docs/rsg-sdk-video).

## Audio resource

`SceneGraphAudio` from `/media` mounts a nonvisual Audio node, with an explicit
MP3, MP4, FLAC, HLS or AAC-ADTS stream format and optional request headers.
Position, duration, state and decoder format come only from field observations.
Pause disables autoplay after seek; source replacement and ancestor removal
request Stop before retiring listeners/nodes. The consumer owns queues,
admission, source-time mapping and progress persistence. There is no native
playlist policy or fabricated decoder acknowledgement.

The resource exposes mute, without fractional volume or playback-rate setters.
These controls require additional consumer/output mechanics before claiming
feature parity. Host contracts and packed SDK compilation do not qualify audible
output, seek accuracy or firmware cleanup. See Roku's
[Audio interface](https://developer.roku.com/dev/docs/rsg-sdk-audio) and
[audio stream formats](https://developer.roku.com/dev/docs/roaudioplayer).

## Wrapped styled text

Nested `Text` with wrapping uses whole-run font widths to break attributed text
into lines. Its native group retains one `MultiStyleLabel` per line, preserving
fonts, colors, explicit blank lines, authored line heights and tail ellipsis.
Line nodes are reused across edits and retired when a paragraph shrinks or its
ancestor unmounts. Exact packaged fonts must finish preparation before commit.
Single-line mixed text retains the direct native label path.

`FontResources` and both project builders select explicit physical font files
from `fonts.families` before measurement, native Labels or raster work. Each
font/raster owner captures its asset map at construction. Caller edits or
deletions keep existing readiness, metadata and newly sized font resources on
that captured map; reconfiguration requires a new owner. Host URI checks and
installed Node/Hermes raster-request checks establish this identity boundary. A logical
family declares `normal`/`italic` maps for static weights 100–900 in steps of 100;
RN `normal` and `bold` select 400 and 700. A missing face or unsupported weight
fails before allocation. Named physical families remain usable by controls that
already select a concrete face and normalize their weight to 400. No synthetic
bold/italic or variable-font axis selection is implied. Applying italic to a
declared physical normal face selects the group's corresponding real italic
file at that physical weight. Conflicting mappings fail explicitly.

The paragraph budget is 64 runs, 32,768 code points and 512 native lines.
Oversized words split at Unicode code-point boundaries; full Unicode line-break
and grapheme segmentation are not implemented. Wrapped tracked/shadowed mixed
text still needs the raster adapter. Native shaping, baseline alignment,
accessibility and physical font fidelity remain device-pending. Host contracts
and independent packed-consumer checks establish layout fields and cleanup.

Tabular digits use an explicit static font asset, shared by measurement, Labels,
mixed text and raster requests. Configure `fonts.variants: ["tabular-nums"]` in
the public project builder. `prepareRokuFontAssets` from `build/project` provides
the same preparation for custom build integrations; `fontVariantFamily` from
`fonts` owns the logical face key. A missing configured face fails before native
allocation instead of silently drawing proportional digits.

The build profile admits standalone static TrueType fonts with an unconditional
single-glyph OpenType `tnum` feature. It retains outlines, advances, Unicode
coverage and license records, changes family identifiers, and recalculates
checksums. Contextual/language-specific feature profiles, variable fonts and
other `fontVariant` values require further implementation and are rejected.
Browser font output and SDK compilation do not qualify native typography.

## Text preparation failure

A failed raster preparation releases its own successful sibling leases
immediately, including siblings that complete later. A synchronous layout walk
failure also retires pending acquisitions. Already committed rasters stay owned
until successful replacement or unmount; an obsolete preparation cannot release
a newer cohort. Started font/raster promises remain observed when a later
synchronous failure prevents the normal join, preserving the original error.

The independent consumer exercises the actual cache within an 80,000-byte
two-entry budget, failed preparation, eviction and recovery. This qualifies
resource ownership with synthetic mask/write ports, not device raster output.
The existing root error contract remains: a latched native failure is surfaced
by the next synchronous flush while a new async preparation may already be
queued; callers must handle that error and await the replacement commit.

Native-root retirement preserves the earliest render/cleanup error while
attempting every service binding, text provider, remaining raster lease and
raster-provider cleanup. One failure cannot skip later owners. A later
`unmount()` retries failed provider/resource actions without replaying successful
cleanup or reviving React/native host authority. Reentrant disposal does not
start a second retirement. `TextRasterCache` closes admission and clears its
budget immediately, while retaining a failed transport-disposal callback for
retry. The independent installed consumer uses the actual bounded cache to
check font, raster-transport and previously latched render failures separately.
These are host error/ownership contracts, not observed device cleanup.

The raster cache reserves a keyed entry and its bytes before invoking draw or
eviction callbacks. Reentrant callers of the same key share that pending result;
a distinct key still requires its own budget. Eviction submission retains its
delete-before-draw order. A callback that retires the cache cannot submit a new
bitmap write, restore an entry or subtract an already cleared reservation.
Throwing draw callbacks retain their original error. Source failure cases and
an independent installed public-cache consumer cover these synchronous callback
boundaries with synthetic file ports; native file completion remains pending.

The SDK host retains its existing single shutdown transaction and reports the
first publication, application-disposal or provider-cleanup failure after all
cleanup steps have been attempted. The raster transport separately tracks its
dispose-request submission and owned reply-observer detachment. Both are
attempted after pending work is rejected; a later call retries only a failed
step. Reentrancy and late replies keep admission closed. Pinned SDK call-boundary
tests and packed SDK compilation cover these mechanics. Native task execution
and physical cleanup remain device-pending.

Owned text-entry and device-facts reply/event handlers submit their previous
callback as the pinned SDK's unregister cue. Device-facts fan-out stops when an
earlier callback disposes the bridge, and repeating an old subscription's
removal cannot delete a replacement subscription. A failed raster request
submission clears its timer and current identity before its queued successor
runs. Source tests retain those failures; the installed public device-facts and
raster bridges separately execute with the actual SDK property function under
Node and explicitly selected Hermes, using synthetic Tree API/timer ports.
Text-entry's unregister call has source and SDK-build coverage. Native event
ordering and physical observer removal remain device-pending.

`FontResources` retains failed identities within its existing resource budget;
failures do not enable automatic retries or reclaim that identity's budget slot.
Native initialization failures preserve the original rejection instead of a
resolved placeholder. Retained nonvisual refs have an acknowledged parent
before field writes, and an unacknowledged insertion is explicitly reattached
before release. A failed removal keeps disposal authority; reentrant cleanup
cannot remove the same ref twice. Disposal attempts all fonts, cancels pending
readiness, reports the first failure, and can retry remaining cleanup while
preparation stays retired. Queued readiness does not start after immediate
disposal, and reentrant metric acquisition cannot publish a retired font as
ready. Fault-injected host ports and SDK compilation establish these error-path
contracts; they do not observe firmware font/transport failure behavior.

## Keyed collections

`FlatList` retains a bounded keyed window. `maxToRenderPerBatch` (default 10)
limits newly added offscreen rows; `updateCellsBatchingPeriod` (default 50 ms)
sets the delay between batches. Visible rows have priority and can exceed this
offscreen budget. Deferred work waits for explicit InteractionManager leases and
is cancelled on data/window/configuration replacement, StrictMode replay and
unmount. Existing keyed native rows and held presses survive window expansion.
These are JavaScript-host contracts, not native-thread or device timing claims.

`ListHeaderComponentStyle` and `ListFooterComponentStyle` apply to internal View
wrappers, separately from each boundary component's own style. Wrapper padding
and measured extent participate in the supported axis's index/end geometry;
the committed origin following a header includes its outer margins too.
Replacing or removing a boundary retires its previous extent. Existing layout
and collection limitations still apply. The independent consumer covers vertical
one/two/three-column and horizontal lists, while the SDK/Canvas horizontal
fixture checks wrapper padding and actual background pixels.

`initialScrollIndex` applies once per mounted list and requires `getItemLayout`
for a nonzero index. It waits for viewport/header measurement and includes the
leading content inset. When an initially empty list receives data, it waits for
the new committed content extent before submitting that request. Removal or
arrival of a header uses current geometry. Explicit scroll commands supersede a pending initial
request. `maintainVisibleContentPosition.minIndexForVisible` selects an actually
visible eligible key, preserving its position through insertion and keyed
reordering. Window selection applies the anchor before reconciliation so the
retained visible owner survives a distant reorder; this host guarantee does not
qualify upstream native reorder behavior. It does not
anchor a row below the viewport or below that minimum index.

`numColumns` groups equal-height items into vertical rows, with
`columnWrapperStyle` composed after the default row direction. Incomplete final
rows retain only their actual items; this is not masonry. The mapping follows
the pinned React Native 0.86.2-0 `FlatList.js`: `renderItem` and `keyExtractor`
receive original item indices, while `getItemLayout` receives the original data
and a **row index**. `initialScrollIndex`, `scrollToIndex`, failed-index reports,
initial/batch limits and separators likewise address rows. Declared offsets must
include row separators and authored spacing. These index spaces are distinct.
`getItemLayout.length` controls index alignment; separator spacing belongs in
successive offsets and does not replace that declared length. Repeated explicit
index/offset commands retain the current committed content clamp even when the
scroll owner emits no changed-offset event. Anchor restoration instead retains
its arriving keyed window until a grown native content extent can accept it.

Row keys concatenate the item keys with `:`; child slots retain local column
identity. Moving an unchanged complete row retains it, while changing a row's
membership can remount its items, including an item that moves to another row.
The default item key uses `key`, then `id`, then its index. Visible and retained
windows contain complete rows, and queued offscreen row batches retire on
replacement/unmount. The independent consumer records bounded work for 30,001
items; a seven-item SDK/Canvas fixture separately checks compilation, viewport
geometry, visible pixels and retirement. Neither proves native scrolling/focus.

Changing the `numColumns` prop requires changing the list's React key to remount
it, matching the pinned upstream invariant. Horizontal grids and
`columnWrapperStyle` on a single-column list fail explicitly.

`horizontal` supports a single windowed lane. Item measurements, declared
lengths/offsets, initial/index/end commands, view-position alignment and viewport
changes use widths and x offsets. Header/footer/empty boundaries, leading and
trailing padding, separators, extraData, queued batching and retirement share
the collection owner. Unknown index geometry reports through
`onScrollToIndexFailed`; `scrollToEnd` can measure the destination tail.
`showsHorizontalScrollIndicator` controls the active-axis indicator. Switching
axes requires a new React key in this subset. Independent packed consumers
exercise declared and measured variable widths with 30,001 items, plus a bounded
SDK/Canvas fixture with actual visible pixels. Touch-drag events remain pending.
`removeClippedSubviews` preserves native groups
inside the retained React window. Device scrolling, memory and frame pacing
remain pending. See the upstream
[batch configuration](https://reactnative.dev/docs/optimizing-flatlist-configuration)
for the responsiveness/fill-rate tradeoff.

`onViewableItemsChanged` and one `viewabilityConfig` form a bounded JavaScript
profile. Known row metrics in the retained range determine viewability after
commit: fully visible rows qualify regardless of the threshold, while partial
rows use exactly one item-visible or viewport-coverage percentage (0–100).
Integer pixel rounding matches the pinned `ViewabilityHelper`. Declared lengths
exclude separator stride; measured cells include their measured separator.
Header and leading padding are included. Multi-column callbacks expand each
qualifying row into original item/index/key tokens, including an incomplete tail.
This is list-viewport geometry; covered, clipped or background windows do not
become native visibility observations.

The default threshold is zero viewport coverage. An authored config must specify
exactly one threshold. `minimumViewTime` accepts a finite nonnegative delay up to
2,147,483,647 ms. Following the pinned helper, each changed index set schedules a
timer that filters its captured indices against the current set when it fires.
Leaving and reentering before an earlier timer fires can qualify at that earlier
time; this does not promise uninterrupted dwell time. Unchanged sets do not
schedule more work. Data/extraData replacement cancels pending old-generation
timers, a stricter owner boundary than the pinned helper's captured old props;
published keys remain the comparison identity. Empty data does not itself emit
removal tokens, matching the pinned helper. A known first-cell metric is required,
so replacing all keys away from the origin without declared geometry can defer
callbacks until that metric is observed.

`waitForInteraction` is released by the list ref's `recordInteraction()`. A
programmatic scroll does not fabricate a native drag or record interaction.
Native drag delivery remains pending. Callback function replacement uses the
current committed function, including pending timer delivery. Same-value configs
are allowed; changing config values or callback nullability requires a new list
React key. `viewabilityConfigCallbackPairs` fails explicitly. Retirement cancels
pending callbacks and revokes saved interaction handles. Independent consumers
cover 30,001 items with bounded retained work; the SDK/Canvas column fixture
separately checks original-item token delivery. This profile does not certify
the complete upstream viewability API or device timing.

## Image preparation

### Preview and Node testing ownership

`/preview` exports `createCanvasFontRegistry` and `observePreviewText` alongside
the Canvas scene and text adapters. Font registries receive registration and
unregistration factories; no native Canvas dependency is required. Each host
creates an owner, awaits `ready(uri, family, signal?)` before measurement, and
calls `dispose()` on retirement. Exact URI/family registrations are shared.
The default 32-entry budget includes pending and failed-release resources;
`retireUnused()` retires idle registrations, attempts independent releases and
keeps failures for an explicit retry. Active fonts are never evicted. Failed
preparation does not publish a registration; a late completion after retirement
releases its token. Factories must return independently releasable tokens.

`observePreviewText(raster)` wraps the public raster provider and exposes a
`snapshot(sceneRoot)` of attached, enabled label/raster text. Released, detached,
hidden and retired raster history cannot satisfy a later assertion. This does
not prove clipping, rendered pixels or native presentation. The wrapper owns
source disposal; the consumer still owns the scene and its asset policy.

`/testing/node` is an explicitly Node/testing entry. `canvasImageSource(image)`
adapts an injected native decoder's `src` clearing to the Canvas preview's
`removeAttribute("src")` contract. `createNodeTextHttp({createPortableFetch})`
adapts Node fetch to the public text-transport contract and exposes bounded
idle/listener diagnostics. Compile/load `createPortableFetch` from the installed
`/web` entry; Node cannot directly strip package TypeScript in node_modules.
An injected custom fetch port defaults to follow-only; strict support requires
an explicit verified `redirectModes: ["follow", "error"]`. The portable layer
rejects undeclared strict policy before sending a request. Native Node fetch
supports that policy; post-response URL inspection alone is insufficient.
Credentials are omitted, binary responses are cancelled/rejected, and abort
forwarders retire after completion or failure. These helpers do not select
application origins, fixture routes, credentials or assertions.

The independent packed consumer exercises these APIs with its own resources and
real loopback GET/POST/status/header/body/abort/redirect/binary controls. The
runtime graph check covers the root, application, preview and SDK host entries
and rejects Node testing IO. Node sockets, Canvas observations
and SDK compilation do not qualify firmware HTTP, fonts, decoding or storage.

Image load state belongs to the resolved source plus `recyclingKey` tuple.
Changing either remounts the Poster and resets partial readiness, dimensions and
terminal status. A completed or failed generation cannot restart from late
observations. Null/empty recycling keys share the default identity. This follows
the [Expo recycling intent](https://docs.expo.dev/versions/latest/sdk/image/#recyclingkey)
within the existing Poster subset, rather than claiming the entire Image API.

Success requires observed readiness and positive intrinsic dimensions. Public
callback chains stop if a callback retires or replaces the image owner.
`onDisplay` here describes a loaded renderable Poster raster; it does not
acknowledge a physical device frame. Host fields and independent packed-consumer
callbacks are distinct from actual browser decode/failure/recovery and visible
Canvas pixels. Native event ordering and display remain device-pending.

Canvas Poster/mask replacement, source clearing, ancestor removal and disposal
detach decoder handlers and remove their source attributes. Already queued
callbacks cannot publish a retired bitmap. This is browser resource ownership,
not device decoder or HTTP-cache certification. Image cache/prefetch methods
continue to return false without an admitted native capability.

## Text entry

The pinned NativeWind focus-style bridge keeps TextInput's focus/blur handlers
without inventing an `onPress` for its internal text display. Authored press
props remain explicit and retain their existing support boundary. Roku Metro
and esbuild use the same source-guarded correction; other platforms keep their
configured transformer unchanged. Independent Metro production/development
Node/Hermes execution and SDK compilation exercise the mounted styled field.
This does not qualify native focus styling or a new TextInput press API.

`TextInput.focus()` uses the mounted host's optional `textEntry` port, or
`DeviceServices.textEntry` when a separate port is not supplied. The SDK host opens Roku's
[StandardKeyboardDialog](https://developer.roku.com/dev/docs/standard-keyboard-dialog).
One dialog is admitted at a time. SDK and Canvas ports publish observed edits to
`onChangeText` while the dialog remains open. Controlled formatting or rejection
updates the same editor; an unchanged controlled echo preserves its draft and
revision. Programmatic updates do not manufacture input events. OK submits the
accepted text through `onSubmitEditing`, without repeating an already observed
change. Cancel/Back ends editing without submission; changes already published
to React are retained. Legacy custom ports without `subscribeText` provide only
accepted-value delivery. Blur, unmount, backgrounding and host retirement
cancel the request; stale replies cannot edit a replacement field. The bridge
limits title/text size, masks secure entry, bounds editing to ten minutes and
clears text-bearing bridge fields after delivery. Ports can also publish actual
selection through `TextEntrySession.subscribeSelection` and ordinary
`onSelectionChange`. The SDK observes the internal VoiceTextEditBox caret and
sends its actual text prefix; JS converts that prefix to UTF-16 offsets without
guessing native character units. Canvas observes DOM ranges, including cursor
movement that does not change text. Initial and programmatic positions are
reported only after reading the editor; missing observations never imply an
end-of-text cursor. Revision, sequence and lifetime fences cover both streams.
Native caret output is collapsed; programmatic selection, native ranges, inline
editing, IME parity and complete Keyboard event support remain outside this
subset. Ports without `subscribeSelection` cannot supply selection observations.
The mechanism uses documented [edit-box fields](https://developer.roku.com/dev/docs/texteditbox)
and [native event identity](https://developer.roku.com/dev/docs/rosgnodeevent);
firmware cursor behavior still requires physical qualification.
Changing a controlled `value` while its editor is active updates that same draft;
uncontrolled `clear()` and imperative text writes also update the editor without
submitting or reopening it. A rerender with the same controlled value does not
overwrite the current draft. Ports expose optional `TextEntrySession.setText`:
return true after admitting the update, or false if already closed. A missing or
failed update capability retires the request and fails explicitly. The SDK sends
monotonic draft revisions and refuses a submission from before the latest update,
while preserving the independent native-close observation. These update paths
have host contracts; actual native editing and race behavior remain unqualified.
`Keyboard.dismiss()` cancels the focused editor and is idle when none is active.
`Keyboard.addListener("keyboardDidHide", listener)` follows the port's actual
closure observation, after accepted text/submission/blur callbacks. Logical
cancellation alone, an unshown editor, a missing acknowledgement or host disposal
cannot manufacture this event. New editors and retired roots fence old callbacks.
Other keyboard events fail explicitly; modal editing supplies no IME geometry,
animation timing or will/show observations. Custom ports can provide the optional
`TextEntrySession.closed` promise: true means an observed close, false means
unconfirmed/disposed/failed admission; omit it when closure cannot be observed.

`TextEntrySession.subscribeText(listener)` returns a remover and replays the latest
observed draft to a late subscriber. SDK observations require the active request,
matching controlled revision and increasing native sequence. Canceled, replaced
and disposed sessions cannot publish edits or restore certainty through a draft
packet. Reentrant edits/control updates fence an older publication. Native
`StandardKeyboardDialog.text` observations are distinct from native closure;
neither a change nor logical cancellation fabricates `keyboardDidHide`. Host
protocol and browser input contracts remain separate from physical keyboard,
voice entry and firmware race qualification.

The SDK bridge keeps cancellation separate from closure acknowledgement. A close
without acknowledgement becomes unconfirmed after ten seconds; further editing
is refused until a matching late acknowledgement restores certainty or the host
is recreated. Native protocol v2 is private to the coordinated JS/native package.

Admitting an external text editor cancels the current JS press/long-press work
and pending background focus requests before opening its port. A reentrant
press-out/cancel callback that focuses another editor supersedes the older
attempt. Late key-up or focus-loss is not required to retire that JS work.
This cancellation does not acknowledge native dialog focus, closure or remote
delivery; those remain physical-device gates.

The default browser preview supplies `createCanvasTextEntry()` from `/preview`.
Its modal DOM editor blocks preview remote input, retains drafts locally, clears
input text on close/disposal and reports closure through the real DOM close event.
Email/numeric domains select input mechanics; shared React retains validation.
Custom Canvas hosts own and dispose this port along with their mounted root.
Physical focus restoration, masking and firmware behavior remain device-pending.

## Navigation history

The Expo Router adapter owns a JavaScript location history. `dismissTo` returns
to the most recent identical normalized href, preserving that entry's identity;
when absent it replaces the current entry. Query ordering is normalized, and
query values cannot override consumer-resolved canonical path parameters.
Invalid navigation does not mutate the retained history. Array path parameters
are copied into immutable snapshots.

`useRouter()` stays bound to its nearest provider and keeps its identity while
that store remains the same. The module-level imperative router selects the most
recently registered live provider; retiring providers out of order cannot
resurrect an unmounted registration. Store disposal remains the consumer's
responsibility. Native navigators, transition options, relative hrefs and the
complete Expo Router API remain outside this subset. The history and provider
contracts run through the React recording renderer; physical navigation and
focus presentation still require device evidence.

Back subscriptions retain callback deduplication, last-registered priority and
consumption before older callbacks. Delivery uses the captured registrations
that still exist: removal during a newer callback retires that registration
immediately, and a replacement or newly added registration waits for the next
event. Repeating an old removal cannot remove a later registration of the same
callback. Input disposal, inactivity or an external editor retiring the current
gesture stops the remaining Back callbacks, even if input becomes active again
before the callback returns. A mounted React route/provider reproduction flushes
the original route's actual cleanup inside a newer Back callback; the removed
callback cannot navigate the arriving route. Source and independent installed
consumer checks establish these host lifetime rules. They do not claim all
upstream mutation quirks or native remote/focus timing.

Observed focus changes retain their target registration and observation order
through held-key cancellation and departing-target blur. Reentrant disposal,
route/target replacement or a newer explicit observation retires the old
continuation before it can acknowledge a successor. Removing only the departing
target still permits the live destination to receive its own observation.
Mounted router/React fixtures
check same-ID route replacement, with the successor's fresh observation
reported separately. These are host callback lifetimes, not physical focus
arrival or native event-order guarantees.

## Device credential serialization

The SDK device-services factory uses the pinned SDK's `DeviceCrypto` device key
and native registry. New secure writes store a `pdr2:` ciphertext containing a
nonempty, versioned JSON string envelope. Empty logical strings, embedded NULs
and escaped lone surrogates round-trip without treating a zero-byte native
decryption as success. Existing nonempty `pdr1:` credentials remain readable
without a write or migration during reads.

Unknown formats, malformed ciphertext, empty native decryption results and invalid
envelopes fail explicitly. Encryption failure cannot write plaintext or flush a
replacement; registry writes retain their serialized flush/rollback contract.
The envelope validates serialization, not ciphertext authenticity or device
protection. Synthetic native-port contracts do not establish hardware key
protection, durable relaunch, interrupted-write or revocation behavior. Those
requirements remain pending native qualification.

## Firmware web boundary

Roku's [documented fetch deviations](https://developer.roku.com/dev/docs/rsg-sdk-standing-docs-runtime-and-debugging-fetch-spec-deviations)
include absent typed feature metadata, a throwing global AbortController
constructor, case-sensitive header names and missing redirect-control fields.
The native transport captures bindings without probing them during offline
startup. It permits an absent feature-metadata function, validates required
bindings when a request is used, and requires a constructible native controller
for cancellable requests. It does not silently replace native cancellation with
a successful-looking logical cancellation. Unsupported requests fail before
network dispatch. Late responses cannot satisfy an aborted caller.

Firmware response headers are normalized before content-type checks. Binary
responses remain unsupported by the text transport and fail before decoding.
`createPortableFetch` from `/web` snapshots the transport's optional
`redirectModes` contract. Omission admits only `follow`; a verified transport
may additionally admit `error` and receives that policy on every request.
Advertising it requires preventing the hop before it occurs. Rejecting a final
response or inspecting its URL cannot undo a leaked credential. The wrapper also
rejects returned redirect statuses or changed final URLs in error mode as a
defensive check. Manual/opaque redirect handling remains unsupported.

The pinned SDK port refuses error mode independently before constructing a
native request. Its missing redirect fields cannot be enabled through a
capability declaration. `Request` construction and cloning retain policy, and
URL fragments are removed before dispatch. Embedded URL credentials and ambient
credential inclusion are rejected before dispatch. Host text-HTTP conformance
can exercise this portable layer without changing those firmware restrictions.
Final redirected URLs cannot be attested through the current firmware response
interface. These limits must be resolved or explicitly satisfied by a verified
transport before enabling an authenticated application that requires stricter
fetch semantics. A host browser's full fetch port does not prove this native
path. The SDK-host unit fixture exercises documented missing globals and late
commit/cleanup behavior; it remains a protocol/lifecycle fixture, not firmware
qualification.

## View identity

Native View/Pressable/ScrollView refs expose ordinary `focus()` as well as
`requestTVFocus()`. Both submit native requests, without publishing an accepted
focus event. `AccessibilityInfo.setAccessibilityFocus(tag)` and
`sendAccessibilityEvent(hostInstance, "focus")` resolve the mounted tag or ref
to its owning root, independently of other roots' mount order. Both use that
same native request; they do not simulate a separate OS reader
cursor or certify accessibility traversal. Unknown/retired tags cannot select a
replacement node. Retired refs cannot measure, focus or mutate a later mount
with the same authored ID, including through a delayed font/native commit.
Only the `focus` accessibility event is implemented; other event types fail
explicitly. Committed accessibility hiding and ordinary native focus admission
still apply. A TextInput ref resolves its current backing host for tag lookup
and accessibility requests, without invoking editing `focus()` or opening its
keyboard. Its non-focusable display label does not become a separately movable
screen-reader cursor.

Focus eligibility is checked after a pending native/font commit. A retained
background ref or accessibility tag can request focus while its modal is being
dismissed, without using the previous commit's blocked placement. Committed
hidden/display-none ancestry rejects input and focus. Becoming ineligible
cancels a held press; revealing that control cannot revive the old gesture.
These mechanical fences do not select a consumer's restoration destination or
fabricate native focus observations.

An unhandled directional press with no authored `nextFocus` link uses committed,
transformed target bounds as a mechanical fallback. It prefers candidates in
the directional beam, then axis-weighted distance, with committed tree order
breaking ties. Explicit tags, null stops and shared input handlers take
precedence. Disabled, hidden, modal-excluded and zero-area targets cannot be
selected. A movement submits the same fenced native focus request as a ref;
only an actual host observation changes input ownership. This host geometry
policy does not certify physical remote latency or native presentation.

Refused focus attempts preserve a held gesture on another eligible control and
cannot supersede an earlier admitted request. Input is fenced when an eligible
native request is submitted; if its target becomes ineligible before the native
acknowledgement, the pending input fence is retired on commit. Modal and hidden
ancestry also disable native focus eligibility rather than only filtering keys.

Focus requests expire after 250 ms without a matching observation. Expiry drops
queued directions and Select gestures from that request. A fresh direction can
retry the same native ID, using the last observed origin if its blur arrived
before the missing gain. The SDK host also samples the requested and previous
native nodes for actual focus, which covers a retry on a node Roku already
focused. A later live observation can restore focus ownership. During recovery,
Select must start after an observation, since a late event for the same native
ID could belong to either request. Back cancels pending input, and retired
targets cannot deliver focus or activation. These rules apply with and without
experimental focus presentation.

`pointerEvents` retains touch hit-testing metadata independently of TV focus.
Opacity zero and accessibility exclusion do not disable a focusable remote
target; accessibility-tag focus and speech still respect accessibility hiding.
Modal isolation, `disabled`, `focusable={false}` and hidden/display-none ancestry
remain separate remote-input fences. Pointer-device dispatch is not implemented.

Absolute layout admits numeric/percentage `inset`, `insetInline`, `insetBlock`
and their start/end aliases. Explicit physical sides override shorthand;
inline aliases override start/end and top/bottom override block-edge aliases.
The current layout direction is LTR; RTL layout remains unqualified.

`createNativeRoot` and `createSceneRoot` accept opt-in `strictMode: true` for
React's development root effect/ref replay. Deferred ref and numeric-tag focus
requests retain their mounted binding generation through that replay. Modal
cleanup waits for committed retirement and suppresses replay-only dismissals.
Nested modal isolation follows hierarchical native paint order; a child's local
z-index is never compared directly with an unrelated parent's. The default root
mode remains unchanged. Host/packed development replay is separate from Roku
firmware execution and production React's behavior.

TextInput keeps one public handle for its mounted lifetime, reads the latest
controlled/accepted text on focus, and cancels its dialog on background,
replacement or retirement. Retired input handles cannot reopen the keyboard or
publish an edit. Native keyboard focus/restoration remains device-pending.

Primitives normalize RN and ARIA accessibility aliases into committed host
semantics. ARIA values override their RN aliases, including false/zero/empty
values; `role` overrides `accessibilityRole`. Pressable's explicit `disabled`
also controls its accessibility disabled state. Labels, hints, labelled-by text,
checked/mixed, `aria-pressed` toggle states, selected, expanded, disabled/busy and range/text values reach the
Audio Guide service on observed focus. A request for focus never speaks as if
focus were accepted. Changed semantics on an already announced focused control
are announced once after commit.

`aria-labelledby` uses an ordered HTML-whitespace ID reference list; commas and
nonbreaking spaces remain part of an ID. An explicit empty ARIA list overrides
the native alias. `accessibilityLabelledBy` supplies one native ID as a string or
an array of explicit IDs, without tokenizing a string. This deliberately follows
[WAI-ARIA ID reference lists](https://www.w3.org/TR/wai-aria-1.2/#valuetype_idref_list)
and the pinned React Native Web 0.21.3 HTML path for the ARIA spelling; the pinned
React Native 0.86.2-0 View implementation instead splits that spelling on commas.
It is a scoped adapter decision, not a claim that those upstream paths agree.

Relationships read direct committed label text from one exposure snapshot, in
reference order, preserving repeated references and skipping missing/empty
sources. A referenced label's own relationship is not followed again, bounding
cycles independently of tree order. Source edits, replacement and retirement
recompute the name; focused updates retain speech de-duplication. Duplicate
mounted native IDs fail explicitly before resolving a name. The host excludes
hidden and modal-background label sources consistently, including a source that
follows its consumer in the tree. This exposure profile differs from HTML's
ability to name a control from an explicitly referenced hidden element. It does
not implement the complete accessible-name algorithm or native traversal.

The committed representation also preserves authored `aria-current`,
`aria-invalid`, `aria-haspopup`, `aria-level`, `aria-orientation` and
`aria-roledescription`. The English speech profile describes these values on
observed focus, focused updates and live-region changes. Current and selected
remain independent. False/empty tokens clear current/invalid state; unknown
nonempty tokens mean true, while an unknown popup token means no popup and true
means menu. Levels require a positive safe integer; orientation is explicit.
Nonempty role descriptions replace the spoken role name only for reviewed
concrete RN/ARIA roles, retaining the underlying role. Missing, unknown and
presentational roles do not acquire a description. These rules follow
[WAI-ARIA 1.2](https://www.w3.org/TR/wai-aria-1.2/).
Field values, including secure text, are not included in these error descriptors.
Structural traversal, relationships, accessibility actions and actual native
speech remain separate requirements; this does not add a native accessibility
tree or fabricate SceneGraph properties.

Live regions suppress busy updates, de-duplicate committed messages, queue
polite updates and submit assertive updates with interruption. Hidden descendants
and the background of the top modal do not announce; modal background controls
cannot activate. A closing animated Modal retains isolation through retirement.
If an announcement port synchronously unmounts or replaces the committed root,
remaining messages from that publication retire before submission. Old delivery
cannot restore its de-duplication records over the successor. Source and packed
consumer checks exercise actual React retirement. This does not cancel
requests already submitted to a native speech queue.
These are an English speech profile and committed host semantics, not native
SceneGraph role fields or a complete OS accessibility tree. Audio Guide speech,
native dialog interference, queue cancellation after native submission, physical
traversal/order and other language profiles remain pending. Host tests and the
independent packed consumer cover props, changes, exposure and cleanup; they do
not certify firmware accessibility.

Observed Pressable focus/blur captures and bubbles through the committed native
View/ScrollView ancestry. `target` and `currentTarget` are measurable host
instances, while `nativeEvent.target` retains the numeric tag. Propagation can
be stopped; a focus command does not synthesize an event. Portalled modal controls
use their mounted ancestry, leaving background scroll hosts untouched. This is
a bounded focus-event adapter, not complete React synthetic-event support.
Consumers retain focus topology and scroll alignment policy. Physical focus,
event ordering and same-frame presentation still require device qualification.

`View.collapsable` is accepted as an optimization hint. This renderer always
retains the native group for both values, preserving refs, native IDs and
measurement when `collapsable={false}` is used. It does not implement layout-only
view removal. Host contracts verify identity and measurement across prop updates;
physical layout still needs device review. Other view props, including
`collapsableChildren`, remain subject to the compatibility registry.

## Windowed collections

`FlatList.extraData` updates the retained window with stable data/render-function
identities. `ItemSeparatorComponent` accepts an element or a component without
props, inserted between rows and omitted after the last row (one item per row
in a single-column list). Measured rows
include separators; declared layouts must include their spacing in offsets.
`renderItem` receives a stable `separators` controller for its mounted keyed
row. `highlight`/`unhighlight` update the separator after that row and the one
before it. `updateProps('leading' | 'trailing', props)` merges consumer props
onto the selected mounted separator. Component separators receive
`highlighted` (initially false) and `leadingItem`; element separators pass
through unchanged. In a grid, `leadingItem` is the entire original row array,
and all items in that row share one controller, matching the pinned upstream
cell renderer. Replaced item objects refresh `leadingItem` while retaining
other separator state. Retired controllers cannot update a returning key.
Measured separators can change size; declared layout remains the consumer's
responsibility. Viewability callbacks remain outside this subset.

`removeClippedSubviews` is an optimization hint: native groups remain attached
inside the retained React window for both values. React windowing still unmounts
retired rows. No native clipping-performance improvement is promised. Immediate
`scrollToEnd` keeps the destination mounted until measured tail geometry has
committed, then releases the temporary anchor. The contracts exercise a thousand
items, navigation back to the start, stable refs and complete scene cleanup.
Repeated End requests use the actual committed content extent, including footer
and trailing insets, even if ScrollView's offset does not change and no new
scroll event is emitted. Four fixed seeds replay 64 bounded geometry/data/input
actions each across one/two/three columns and the horizontal lane. Minimized
alignment, removed-header, repeated-End/prepend and delayed-data regressions
also run through an independent packed consumer. These are deterministic host
contracts, not firmware timing or performance qualification.
