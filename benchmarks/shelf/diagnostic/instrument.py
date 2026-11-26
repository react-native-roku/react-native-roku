"""Apply benchmark probes to a disposable unpacking of the selected archive."""

import json
import shutil
import sys
from pathlib import Path

root = Path(sys.argv[1])
here = Path(__file__).parent
shutil.copyfile(here / "marker.ts", root / "src/shelfTrace.ts")


def patch(name, substitutions, imports=""):
    path = root / name
    text = path.read_text()
    for old, new in substitutions:
        if text.count(old) != 1:
            raise ValueError(f"{name}: expected one {old!r}")
        text = text.replace(old, new, 1)
    path.write_text(imports + text)


patch("src/scene/createRokuHost.ts", [
    ('      keys.handle(event.key, event.press, (intent) => {',
     '      traceKey(event.key, event.press, () => keys.handle(event.key, event.press, (intent) => {'),
    ('        return handled;\n      });', '        return handled;\n      }));'),
], 'import { keyEvent as traceKey } from "../shelfTrace";\n')
patch("src/react-native/NativeInput.ts", [
    ('{ key: NativeDirection; repeat: boolean }', '{ key: NativeDirection; repeat: boolean; input: number }'),
    ('    this.requestedFocus = { id, origin };', '    this.requestedFocus = { id, origin };\n    traceRequest(id);'),
    ('    this.batch(() => {\n      const target = this.targets.get(id);',
     '    traceFocus(id, focused);\n    mark("focus.enqueue", { target: id, focused });\n    this.batch(() => {\n      mark("focus.execute", { target: id, focused });\n      const target = this.targets.get(id);'),
    ('        target.focus(true);', '        mark("focus.target", { target: id });\n        target.focus(true);'),
    ('      if (this.requestedFocus || this.blockedSelect) {',
     '      if (this.requestedFocus || this.blockedSelect) {\n        mark("select.fenced", { phase: event.phase, pending: this.requestedFocus?.id ?? "", owner: this.focused ?? "" });'),
    ('    )\n      this.queuedDirections.push({ key, repeat });',
     '    ) {\n      this.queuedDirections.push({ key, repeat, input: currentInput() });\n      mark("direction.enqueue", { key });\n    }'),
    ('this.navigation?.(next.key);',
     '      withInput(next.input, () => {\n        mark("direction.execute", { key: next.key });\n        this.navigation?.(next.key);\n      });'),
], 'import { currentInput, deliverFocus as traceFocus, mark, requestFocus as traceRequest, withInput } from "../shelfTrace";\n')
native_input = (root / "src/react-native/NativeInput.ts").read_text()
if "private queueSelect(" in native_input:
    patch("src/react-native/NativeInput.ts", [
        ('phase: "down" | "up"; gesture: object', 'phase: "down" | "up"; gesture: object; input: number'),
        ('phase: "up", gesture: this.queuedSelect', 'phase: "up", gesture: this.queuedSelect, input: currentInput()'),
        ('phase: "down", gesture: this.queuedSelect', 'phase: "down", gesture: this.queuedSelect, input: currentInput()'),
        ('        this.dispatchNow(next);', '        withInput(next.input, () => {\n          mark("select.execute", { phase: next.phase });\n          this.dispatchNow(next);\n        });'),
    ])
patch("src/react-native/primitives.ts", [
    ('        focus(focused) {\n          setState(', '        focus(focused) {\n          mark("focus.state.schedule", { target: id, focused });\n          setState('),
    ('          host.dispatchFocus(id, focused);','          mark("focus.callback.dispatch", { target: id, focused });\n          host.dispatchFocus(id, focused);'),
    ('        focusedChild: (value: unknown) => input.observeFocus(id, value === element.fields.id),',
     '        focusedChild: (value: unknown) => {\n          mark("sdk.focus.observer", { target: id, value: typeof value === "string" ? value : "" });\n          input.observeFocus(id, value === element.fields.id);\n        },'),
], 'import { mark } from "../shelfTrace";\n')
scene_root = (root / "src/renderer/SceneRoot.ts").read_text()
scene_markers = [
    ('      const generation = ++state.generation;', '      const generation = ++state.generation;\n      mark(reactCommit ? "react.commit" : "native.refresh", { commit: generation });'),
    ('        options.afterCommit?.(tree);', '        mark("fields.done", { commit: generation });\n        options.afterCommit?.(tree);'),
    ('        if (prepared instanceof Promise) state.pending = prepared.then(apply).catch(fail);',
     '        if (prepared instanceof Promise) {\n          mark("fields.enqueue", { commit: generation });\n          state.pending = prepared.then(apply).catch(fail);\n        }'),
    ('      if (syncDepth) {\n        work();', '      mark("react.work.start", { nested: syncDepth > 0 });\n      if (syncDepth) {\n        work();'),
    ('  prepareForCommit: () => {',
     '  prepareForCommit: () => {\n    mark("react.mutations.start");'),
    ('  resetAfterCommit(root) {',
     '  resetAfterCommit(root) {\n    mark("react.mutations.end");'),
    ('        reconciler.flushSyncFromReconciler(work);',
     '        reconciler.flushSyncFromReconciler(() => {\n          mark("react.event.start");\n          try {\n            work();\n          } finally {\n            mark("react.event.end");\n          }\n        });'),
]
if "function commitStableFields(" in scene_root:
    scene_markers += [
        ('        if (\n          !changes ||',
         '        mark("fields.apply", { commit: generation });\n        if (\n          !changes ||'),
        ('  if (affected.length)\n    root.port.batch',
         '  mark("fields.affected", { count: affected.length, realized: root.realized.size });\n  if (affected.length)\n    root.port.batch'),
    ]
else:
    scene_markers += [
        ('        commitTree(state, fields, options.inlineTextLines);',
         '        mark("fields.apply", { commit: generation });\n        commitTree(state, fields, options.inlineTextLines);'),
    ]
patch("src/renderer/SceneRoot.ts", scene_markers, 'import { mark } from "../shelfTrace";\n')
patch("src/scene/SdkSceneGraph.ts", [
    ('    tmTransaction.setProperty(this.native(node), field, this.convert(nativeValue) as TmValue);',
     '    const native = this.native(node);\n    traceField(native, native.parent, field, nativeValue);\n    tmTransaction.setProperty(native, field, this.convert(nativeValue) as TmValue);'),
], 'import { field as traceField } from "../shelfTrace";\n')
native_root = (root / "src/react-native/createNativeRoot.ts").read_text()
walk_start = '          parentVisible = true,\n        ) => {'
if "if (visited && !visited.has(entry)) return;" in native_root:
    walk_start += '\n          if (visited && !visited.has(entry)) return;'
retained_layout_markers = []
if "const settled = retainedLayout();" in native_root:
    retained_layout_markers.append(
        ('      const settled = retainedLayout();',
         '      const settled = retainedLayout();\n      mark("layout.retained", { reuse: !!settled });'),
    )
bases_start = ('        const bases = new Map<SceneTreeElement, SceneFields>('
               if retained_layout_markers else
               '        const bases = new Map<SceneTreeElement, SceneFields>();')
sparse_placement = "let fieldBase = settled ? previous?.fields : undefined;" in native_root
validation_end = (
    "        let fieldBase = settled ? previous?.fields : undefined;"
    if sparse_placement
    else "        const fields = new Map<SceneTreeElement, SceneFields>(previous?.fields),"
)
pending_placement = (
    "        pending.set(tree, { entries: next, local });"
    if sparse_placement
    else "        pending.set(tree, next);"
)
if sparse_placement:
    placement_published = "      const generation = ++publication;"
    retained_layout_markers.extend([
        ('    afterCommit(tree) {', '    afterCommit(tree) {\n      mark("placements.publish.start");'),
        (placement_published,
         '      mark("placements.publish.end", { reuse: update?.local === true, count: update?.entries.size ?? 0 });\n'
         + placement_published),
    ])
patch("src/react-native/createNativeRoot.ts", retained_layout_markers + [
    ('      const generation = ++rasterGeneration;', '      mark("layout.input.start");\n      const generation = ++rasterGeneration;'),
    ('      const finish = () => {', '      mark("layout.input.end");\n      const finish = () => {\n        mark("layout.compare.start");'),
    ('        const layout = reuse\n', '        mark("layout.compare.end", { reuse: !!reuse });\n        const layout = reuse\n'),
    ('        const prepareNode = preparedFields.begin', '        mark("layout.geometry.end");\n        const prepareNode = preparedFields.begin'),
    (bases_start, '        mark("layout.validate.start");\n' + bases_start),
    (validation_end, '        mark("layout.validate.end");\n' + validation_end),
    ('        let lastBackground: SceneFields | undefined;', '        mark("layout.snapshot.end");\n        let walkVisits = 0;\n        let lastBackground: SceneFields | undefined;'),
    (walk_start, walk_start + '\n          walkVisits++;'),
    (pending_placement,
     '        mark("layout.placements.end", { walkVisits, fieldCount: fields.size, placementCount: next.size });\n'
     + pending_placement),
], 'import { mark } from "../shelfTrace";\n')
script = (here / "native.brs").read_text() + "".join(
    f"\nsub shelfNativeFocus{card}(event as Object)\n    shelfNativeFocus(event)\nend sub\n"
    for card in range(24)
)
end = r'.setFocus(true)\nend sub\n`'
patch("build/project.mjs", [
    (end, r'.setFocus(true)\n startShelfFocusProbe()\nend sub\n` + ' + json.dumps(script)),
])
