import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { packageRoot } from "../build/index.mjs";
import { openTestBrowser, until, pause } from "./browserHarness.mjs";
import { ensureQualificationStorage } from "./qualificationStorage.mjs";
await ensureQualificationStorage({ projectRoot: packageRoot });
const evidence = resolve(process.env.ROKU_QUALIFY_EVIDENCE_DIR ?? resolve(packageRoot, ".local"));
const sdk = JSON.parse(readFileSync(resolve(evidence, "sdk-consumer-proof.json")));
const root = sdk.consumer,
  require = createRequire(resolve(root, "package.json"));
const { createRokuDevServer } = await import(
  pathToFileURL(require.resolve("react-native-roku/build/dev"))
);
const { buildRokuPreview } = await import(
  pathToFileURL(require.resolve("react-native-roku/build/project"))
);
const app = resolve(root, "src/App.tsx"),
  original = readFileSync(app, "utf8");
const component = original.match(/export default function (\w+)\(/)?.[1];
assert.ok(component, "The generated component entry must remain an ordinary default function");
copyFileSync(
  resolve(packageRoot, "examples/minimal/src/columnsFixture.tsx"),
  resolve(root, "src/ColumnsFixture.tsx"),
);
const needsColumns = !original.includes('from "./ColumnsFixture"');
copyFileSync(
  resolve(packageRoot, "examples/minimal/src/horizontalFixture.tsx"),
  resolve(root, "src/HorizontalFixture.tsx"),
);
const needsHorizontal = !original.includes('from "./HorizontalFixture"');
copyFileSync(
  resolve(packageRoot, "examples/minimal/src/imageLifecycleFixture.tsx"),
  resolve(root, "src/ImageLifecycleFixture.tsx"),
);
const needsImageLifecycle = !original.includes('from "./ImageLifecycleFixture"');
copyFileSync(
  resolve(packageRoot, "examples/minimal/src/modalOrderFixture.tsx"),
  resolve(root, "src/ModalOrderFixture.tsx"),
);
const needsModalOrder = !original.includes('from "./ModalOrderFixture"');
// Keep product templates small. This consumer-only fixture exercises the public
// preview port with real React TextInputs and the public Keyboard API.
const withKeyboard = (source) =>
  source.replace("export default function ", "function ") +
  `
import {useRef as keyboardRef,useEffect as keyboardEffect,useState as keyboardState} from 'react';
import {TextInput as KeyboardInput,Keyboard as ConsumerKeyboard} from 'react-native';
import {ColumnsFixture as DevelopmentColumnsFixture} from './ColumnsFixture';
import {HorizontalFixture as DevelopmentHorizontalFixture} from './HorizontalFixture';
import {ImageLifecycleFixture as DevelopmentImageLifecycleFixture} from './ImageLifecycleFixture';
import {ModalOrderFixture as DevelopmentModalOrderFixture} from './ModalOrderFixture';
function KeyboardFixture(){
 const first=keyboardRef<import('react').ElementRef<typeof KeyboardInput>>(null);
 const second=keyboardRef<import('react').ElementRef<typeof KeyboardInput>>(null);
 const controlled=keyboardRef<import('react').ElementRef<typeof KeyboardInput>>(null);
 const [controlledValue,setControlledValue]=keyboardState('Controlled');
 const [editPolicy,setEditPolicy]=keyboardState('echo');
 const current=keyboardRef({value:controlledValue,policy:editPolicy});current.current={value:controlledValue,policy:editPolicy};
 const events=keyboardRef<string[]>([]);
 const selections=keyboardRef<{name:string,start:number,end:number}[]>([]);
 keyboardEffect(()=>{
  const api={events:events.current,selections:selections.current,first:()=>first.current!.focus(),second:()=>second.current!.focus(),controlled:()=>controlled.current!.focus(),reset:setControlledValue,policy:setEditPolicy,snapshot:()=>current.current,clear:()=>first.current!.clear(),write:(text:string)=>first.current!.setNativeProps({text}),dismiss:()=>ConsumerKeyboard.dismiss()};
  const target=globalThis as unknown as {__KEYBOARD_CONSUMER__?:typeof api};target.__KEYBOARD_CONSUMER__=api;
  const listener=ConsumerKeyboard.addListener('keyboardDidHide',()=>{
   events.current.push('hide');if(first.current?.isFocused())first.current.blur();
  });
  return()=>{listener.remove();delete target.__KEYBOARD_CONSUMER__;};
 },[]);
 const props=(name:string)=>({onFocus:()=>events.current.push(name+':focus'),onBlur:()=>events.current.push(name+':blur'),onChangeText:(value:string)=>events.current.push(name+':change:'+value),onSelectionChange:(event:{nativeEvent:{selection:{start:number,end:number}}})=>selections.current.push({name,...event.nativeEvent.selection}),onSubmitEditing:(event:{nativeEvent:{text:string}})=>events.current.push(name+':submit:'+event.nativeEvent.text)});
 return <><KeyboardInput ref={first} defaultValue='Seed' secureTextEntry maxLength={32} {...props('first')}/><KeyboardInput ref={second} keyboardType='email-address' {...props('second')}/><KeyboardInput ref={controlled} value={controlledValue} {...props('controlled')} onChangeText={text=>{props('controlled').onChangeText(text);if(editPolicy==='echo')setControlledValue(text);if(editPolicy==='uppercase')setControlledValue(text.toUpperCase());}}/></>;
}
export default function KeyboardConsumer(){return <><${component}/><KeyboardFixture/>${needsColumns ? "<DevelopmentColumnsFixture/>" : ""}${needsHorizontal ? "<DevelopmentHorizontalFixture/>" : ""}${needsImageLifecycle ? "<DevelopmentImageLifecycleFixture/>" : ""}${needsModalOrder ? "<DevelopmentModalOrderFixture/>" : ""}</>;}
`;
const events = [];
let server;
let browser,
  stage = "browser-startup";
try {
  writeFileSync(app, withKeyboard(original));
  server = await createRokuDevServer({
    port: 0,
    watchPaths: [resolve(root, "src")],
    build: ({ generation }) =>
      buildRokuPreview(root, {
        outputDirectory: resolve(root, ".roku/dev-proof", String(generation)),
      }),
    onBuild: (event) => events.push(event),
  });
  browser = await openTestBrowser(server.url);
  stage = "initial-render";
  const texts = () => browser.evaluate("window.__ROKU_DEV__?.snapshot().texts");
  await until(async () => {
    const value = await texts();
    return value?.includes("Hello, Roku");
  });
  stage = "session-write";
  const digitFaces = await browser.evaluate(`(()=>{
    const context=document.querySelector('canvas').getContext('2d');
    return [...new Set([...document.fonts].map(face=>face.family))]
      .filter(family=>family.startsWith('react-native-roku-font-'))
      .map(family=>{context.font='48px "'+family+'"';return {family,widths:Array.from({length:10},(_,i)=>context.measureText(String(i)).width)};});
  })()`);
  assert.ok(
    digitFaces.some((face) => new Set(face.widths).size === 1),
    "Packed preview did not load the tabular face",
  );
  assert.ok(
    digitFaces.some((face) => new Set(face.widths).size > 1),
    "Variant face replaced the ordinary font",
  );
  const fontRequests = await browser.evaluate(`performance.getEntriesByType('resource')
    .map(entry=>new URL(entry.name).pathname).filter(path=>path.startsWith('/fonts/'))`);
  for (const path of [
    "/fonts/font-0.ttf",
    "/fonts/font-1.ttf",
    "/fonts/font-2.ttf",
    "/fonts/font-4.ttf",
    "/fonts/font-6.ttf",
  ])
    assert.ok(fontRequests.includes(path), `Packed preview did not load selected face ${path}`);
  assert.equal(
    digitFaces.length,
    5,
    "Regular, tabular, bold and both italic weights must have distinct physical identities",
  );
  assert.ok((await texts()).includes("Weighted 700"));
  assert.ok((await texts()).includes("Italic 400"));
  assert.ok((await texts()).includes("Physical italic 700"));
  stage = "bounded-column-geometry";
  const columns = await until(async () => {
    const value = await browser.evaluate("globalThis.__RNR_COLUMNS_FIXTURE__?.snapshot()");
    return value?.length === 7 ? value : null;
  });
  for (const [index, rect] of columns.entries()) {
    assert.equal(rect.id, String(index));
    assert.equal(rect.x, columns[0].x + (index % 3) * 108);
    assert.equal(rect.y, columns[0].y + Math.floor(index / 3) * 44);
    assert.equal(rect.width, 100);
    assert.equal(rect.height, 40);
  }
  const columnViewability = await until(async () => {
    const value = await browser.evaluate("globalThis.__RNR_COLUMNS_FIXTURE__?.viewability()");
    return value?.length === 7 ? value : null;
  });
  assert.deepEqual(
    columnViewability,
    Array.from({ length: 7 }, (_, index) => ({
      item: String(index),
      key: String(index),
      index,
      isViewable: true,
    })),
  );
  const canvasSize = await browser.evaluate(
    "(()=>{const c=document.querySelector('canvas');return{width:c.width,height:c.height}})()",
  );
  for (const rect of columns) {
    assert.ok(
      rect.x >= 0 &&
        rect.y >= 0 &&
        rect.x + rect.width <= canvasSize.width &&
        rect.y + rect.height <= canvasSize.height,
      "Every fixture column must fit inside the actual Canvas viewport",
    );
  }
  const columnPixels = await until(() =>
    browser.evaluate(`(()=>{
    const canvas=document.querySelector('canvas'),context=canvas.getContext('2d');
    const rectangles=globalThis.__RNR_COLUMNS_FIXTURE__?.snapshot();
    if(rectangles?.length!==7)return null;
    const pixels=rectangles.map(rect=>[...context.getImageData(Math.floor(rect.x+rect.width-4),Math.floor(rect.y+rect.height-4),1,1).data]);
    return pixels.every(pixel=>pixel.join(',')==='34,68,102,255')?pixels:null;
  })()`),
  );
  mkdirSync(evidence, { recursive: true });
  const columnsImage = await browser.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(evidence, "columns-canvas.png"), Buffer.from(columnsImage.data, "base64"));
  stage = "column-separator-updates";
  const separatorRectangles = await until(async () => {
    const value = await browser.evaluate("globalThis.__RNR_COLUMNS_FIXTURE__?.separatorSnapshot()");
    return value?.length === 2 ? value : null;
  });
  assert.deepEqual(
    separatorRectangles.map(({ id, y, height }) => ({ id, y, height })),
    [
      { id: "0", y: 340, height: 4 },
      { id: "3", y: 384, height: 4 },
    ],
  );
  const readSeparatorPixels = `(()=>{
    const context=document.querySelector('canvas').getContext('2d');
    return globalThis.__RNR_COLUMNS_FIXTURE__.separatorSnapshot().map(rect=>[...context.getImageData(rect.x+4,rect.y+2,1,1).data]);
  })()`;
  const separatorBefore = await browser.evaluate(readSeparatorPixels);
  await browser.evaluate("globalThis.__RNR_COLUMNS_FIXTURE__.highlight('3')");
  const separatorHighlighted = await until(async () => {
    const pixels = await browser.evaluate(readSeparatorPixels);
    return pixels.every((pixel) => pixel.join(",") === "153,51,17,255") ? pixels : null;
  });
  const separatorImage = await browser.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    resolve(evidence, "separators-canvas.png"),
    Buffer.from(separatorImage.data, "base64"),
  );
  await browser.evaluate("globalThis.__RNR_COLUMNS_FIXTURE__.unhighlight('3')");
  await until(
    async () =>
      JSON.stringify(await browser.evaluate(readSeparatorPixels)) ===
      JSON.stringify(separatorBefore),
  );
  stage = "bounded-horizontal-geometry";
  const horizontalStart = await until(async () => {
    const value = await browser.evaluate("globalThis.__RNR_HORIZONTAL_FIXTURE__?.snapshot()");
    return value?.find((rect) => rect.id === "0" && rect.x === 1049) ? value : null;
  });
  for (const [id, x, width] of [
    ["0", 1049, 60],
    ["1", 1109, 80],
    ["2", 1189, 100],
  ]) {
    assert.deepEqual(
      horizontalStart.find((rect) => rect.id === id),
      { id, x, y: 460, width, height: 40 },
    );
  }
  const headerWrapperPixel = await until(() =>
    browser.evaluate(`(()=>{
    const context=document.querySelector('canvas').getContext('2d');
    const pixel=[...context.getImageData(1012,462,1,1).data];
    return pixel.join(',')==='102,51,153,255'?pixel:null;
  })()`),
  );
  await browser.evaluate("globalThis.__RNR_HORIZONTAL_FIXTURE__.end()");
  const horizontalEnd = await until(async () => {
    const value = await browser.evaluate("globalThis.__RNR_HORIZONTAL_FIXTURE__?.snapshot()");
    return value?.find((rect) => rect.id === "16" && rect.x === 1224) ? value : null;
  });
  assert.deepEqual(
    horizontalEnd.find((rect) => rect.id === "footer"),
    { id: "footer", x: 1308, y: 460, width: 17, height: 40 },
  );
  const footerWrapperPixel = await until(() =>
    browser.evaluate(`(()=>{
    const context=document.querySelector('canvas').getContext('2d');
    const pixel=[...context.getImageData(1305,462,1,1).data];
    return pixel.join(',')==='34,119,136,255'?pixel:null;
  })()`),
  );
  const horizontalPixels = await until(() =>
    browser.evaluate(`(()=>{
    const canvas=document.querySelector('canvas'),context=canvas.getContext('2d');
    const rect=globalThis.__RNR_HORIZONTAL_FIXTURE__?.snapshot().find(rect=>rect.id==='16');
    if(!rect || rect.x!==1224)return null;
    const pixel=[...context.getImageData(rect.x+rect.width-4,rect.y+rect.height-4,1,1).data];
    return pixel.join(',')==='68,102,34,255'?pixel:null;
  })()`),
  );
  await browser.evaluate("globalThis.__RNR_HORIZONTAL_FIXTURE__.start()");
  await until(async () =>
    (await browser.evaluate("globalThis.__RNR_HORIZONTAL_FIXTURE__?.snapshot()"))?.find(
      (rect) => rect.id === "0" && rect.x === 1049,
    ),
  );
  stage = "image-recycling-lifetime";
  const imageCycle = async (cycle) =>
    until(async () => {
      const value = await browser.evaluate("globalThis.__RNR_IMAGE_LIFECYCLE__?.snapshot()");
      return value?.events.some((event) => event.cycle === cycle && event.event === "end")
        ? value
        : null;
    });
  const imageInitial = await imageCycle("initial");
  assert.deepEqual(imageInitial.rect, { x: 1450, y: 300, width: 80, height: 60 });
  assert.deepEqual(imageInitial.events, [
    { cycle: "initial", event: "load", width: 2, height: 2 },
    { cycle: "initial", event: "display" },
    { cycle: "initial", event: "end" },
  ]);
  const imagePixel = await until(() =>
    browser.evaluate(`(()=>{
    const pixel=[...document.querySelector('canvas').getContext('2d').getImageData(1454,304,1,1).data];
    return pixel.join(',')==='34,102,136,255'?pixel:null;
  })()`),
  );
  await browser.evaluate("globalThis.__RNR_IMAGE_LIFECYCLE__.recycle('recycled')");
  const imageRecycled = await imageCycle("recycled");
  assert.deepEqual(
    imageRecycled.events.filter((event) => event.cycle === "recycled"),
    [
      { cycle: "recycled", event: "load", width: 2, height: 2 },
      { cycle: "recycled", event: "display" },
      { cycle: "recycled", event: "end" },
    ],
  );
  await browser.evaluate(
    "globalThis.__RNR_IMAGE_LIFECYCLE__.load('failed',new URL('/__rnr_missing_image_lifetime.png',location.href).href)",
  );
  const imageFailed = await imageCycle("failed");
  assert.deepEqual(
    imageFailed.events.filter((event) => event.cycle === "failed"),
    [
      { cycle: "failed", event: "error" },
      { cycle: "failed", event: "end" },
    ],
  );
  await browser.evaluate("globalThis.__RNR_IMAGE_LIFECYCLE__.reset('recovered')");
  const imageRecovered = await imageCycle("recovered");
  assert.deepEqual(
    imageRecovered.events.filter((event) => event.cycle === "recovered"),
    [
      { cycle: "recovered", event: "load", width: 2, height: 2 },
      { cycle: "recovered", event: "display" },
      { cycle: "recovered", event: "end" },
    ],
  );
  await browser.evaluate("globalThis.__RNR_IMAGE_LIFECYCLE__.retire()");
  await until(
    async () => !(await browser.evaluate("globalThis.__RNR_IMAGE_LIFECYCLE__.snapshot()")).rect,
  );
  stage = "modal-presentation-order";
  const modalPixel = (expected) =>
    until(() =>
      browser.evaluate(`(()=>{
    const pixel=[...document.querySelector('canvas').getContext('2d').getImageData(1454,624,1,1).data];
    return pixel.join(',')===${JSON.stringify(expected.join(","))}?pixel:null;
  })()`),
    );
  await browser.evaluate("globalThis.__RNR_MODAL_ORDER__.open('b')");
  const modalBlue = await modalPixel([51, 85, 170, 255]);
  let modalRed;
  for (let turn = 0; turn < 2; turn++) {
    await browser.evaluate("globalThis.__RNR_MODAL_ORDER__.open('a')");
    modalRed = await modalPixel([170, 51, 68, 255]);
    if (turn === 0) {
      const screenshot = await browser.call("Page.captureScreenshot", { format: "png" });
      writeFileSync(
        resolve(evidence, "modal-order-canvas.png"),
        Buffer.from(screenshot.data, "base64"),
      );
    }
    await browser.evaluate(
      "window.__ROKU_DEV__.remote({key:'back',phase:'down'});window.__ROKU_DEV__.remote({key:'back',phase:'up'})",
    );
    await until(async () => {
      const state = await browser.evaluate("globalThis.__RNR_MODAL_ORDER__.snapshot()");
      return !state.a && state.b && state.closed.length === turn + 1;
    });
    await modalPixel([51, 85, 170, 255]);
  }
  await browser.evaluate(
    "window.__ROKU_DEV__.remote({key:'back',phase:'down'});window.__ROKU_DEV__.remote({key:'back',phase:'up'})",
  );
  const modalOrder = await until(async () => {
    const state = await browser.evaluate("globalThis.__RNR_MODAL_ORDER__.snapshot()");
    return !state.a && !state.b ? state : null;
  });
  assert.deepEqual(modalOrder.closed, ["a", "a", "b"]);
  stage = "keyboard-submit";
  await until(() => browser.evaluate("!!globalThis.__KEYBOARD_CONSUMER__"));
  await browser.evaluate("__KEYBOARD_CONSUMER__.first()");
  assert.equal(await browser.evaluate("document.querySelector('dialog input').type"), "password");
  assert.equal(
    await browser.evaluate("window.__ROKU_DEV__.remote({key:'select',phase:'down'})"),
    false,
  );
  await browser.evaluate("document.querySelector('dialog input').value='Accepted'");
  await browser.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    windowsVirtualKeyCode: 13,
  });
  await browser.call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await until(() => browser.evaluate("__KEYBOARD_CONSUMER__.events.includes('hide')"));
  assert.deepEqual(await browser.evaluate("__KEYBOARD_CONSUMER__.events"), [
    "first:focus",
    "first:change:Accepted",
    "first:submit:Accepted",
    "first:blur",
    "hide",
  ]);
  assert.ok(
    (await texts()).includes("Pressed 0 times"),
    "Keyboard Enter leaked into remote activation",
  );
  stage = "keyboard-cancel";
  await browser.evaluate(
    "__KEYBOARD_CONSUMER__.events.length=0;__KEYBOARD_CONSUMER__.first();document.querySelector('dialog input').value='Discarded'",
  );
  await browser.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await browser.call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await until(() => browser.evaluate("__KEYBOARD_CONSUMER__.events.includes('hide')"));
  assert.deepEqual(await browser.evaluate("__KEYBOARD_CONSUMER__.events"), [
    "first:focus",
    "first:blur",
    "hide",
  ]);
  stage = "keyboard-replacement";
  await browser.evaluate(
    "__KEYBOARD_CONSUMER__.events.length=0;__KEYBOARD_CONSUMER__.first();__KEYBOARD_CONSUMER__.second()",
  );
  await until(() => browser.evaluate("document.querySelectorAll('dialog').length===1"));
  assert.deepEqual(await browser.evaluate("__KEYBOARD_CONSUMER__.events"), [
    "first:focus",
    "first:blur",
    "second:focus",
  ]);
  await browser.evaluate(
    "document.querySelector('dialog input').value='not-an-email';document.querySelector('dialog form').requestSubmit()",
  );
  await until(() => browser.evaluate("__KEYBOARD_CONSUMER__.events.includes('hide')"));
  assert.deepEqual(await browser.evaluate("__KEYBOARD_CONSUMER__.events"), [
    "first:focus",
    "first:blur",
    "second:focus",
    "second:change:not-an-email",
    "second:submit:not-an-email",
    "second:blur",
    "hide",
  ]);
  stage = "keyboard-dismiss";
  const beforeClose = await browser.evaluate(
    "__KEYBOARD_CONSUMER__.events.length=0;__KEYBOARD_CONSUMER__.first();__KEYBOARD_CONSUMER__.dismiss();[...__KEYBOARD_CONSUMER__.events]",
  );
  assert.deepEqual(beforeClose, ["first:focus", "first:blur"]);
  await until(() => browser.evaluate("__KEYBOARD_CONSUMER__.events.includes('hide')"));
  stage = "keyboard-controlled-update";
  await browser.evaluate(
    "__KEYBOARD_CONSUMER__.events.length=0;__KEYBOARD_CONSUMER__.controlled();globalThis.__EDITOR_NODE__=document.querySelector('dialog input');__KEYBOARD_CONSUMER__.reset('Reset')",
  );
  await until(() => browser.evaluate("document.querySelector('dialog input')?.value==='Reset'"));
  assert.equal(
    await browser.evaluate(
      "document.querySelector('dialog input')===__EDITOR_NODE__ && document.activeElement===__EDITOR_NODE__",
    ),
    true,
  );
  assert.deepEqual(await browser.evaluate("[...__KEYBOARD_CONSUMER__.events]"), [
    "controlled:focus",
  ]);
  await browser.evaluate(
    "document.querySelector('dialog input').value='after reset';document.querySelector('dialog form').requestSubmit()",
  );
  await until(() => browser.evaluate("!document.querySelector('dialog')"));
  assert.deepEqual(await browser.evaluate("[...__KEYBOARD_CONSUMER__.events]"), [
    "controlled:focus",
    "controlled:change:after reset",
    "controlled:submit:after reset",
    "controlled:blur",
    "hide",
  ]);
  stage = "keyboard-imperative-update";
  await browser.evaluate(
    "__KEYBOARD_CONSUMER__.events.length=0;__KEYBOARD_CONSUMER__.first();globalThis.__EDITOR_NODE__=document.querySelector('dialog input');__KEYBOARD_CONSUMER__.clear()",
  );
  assert.equal(await browser.evaluate("document.querySelector('dialog input').value"), "");
  await browser.evaluate("__KEYBOARD_CONSUMER__.write('Replacement')");
  assert.equal(
    await browser.evaluate("document.querySelector('dialog input').value"),
    "Replacement",
  );
  assert.equal(
    await browser.evaluate(
      "document.querySelector('dialog input')===__EDITOR_NODE__ && document.activeElement===__EDITOR_NODE__",
    ),
    true,
  );
  assert.deepEqual(await browser.evaluate("[...__KEYBOARD_CONSUMER__.events]"), ["first:focus"]);
  await browser.evaluate("document.querySelector('dialog form').requestSubmit()");
  await until(() => browser.evaluate("!document.querySelector('dialog')"));
  assert.deepEqual(await browser.evaluate("[...__KEYBOARD_CONSUMER__.events]"), [
    "first:focus",
    "first:submit:Replacement",
    "first:blur",
    "hide",
  ]);
  stage = "keyboard-selection-observations";
  await browser.evaluate(
    "__KEYBOARD_CONSUMER__.events.length=0;__KEYBOARD_CONSUMER__.selections.length=0;__KEYBOARD_CONSUMER__.first();globalThis.__SELECTION_EDITOR__=document.querySelector('dialog input')",
  );
  await until(() => browser.evaluate("__KEYBOARD_CONSUMER__.selections.length>0"));
  assert.deepEqual(
    await browser.evaluate("__KEYBOARD_CONSUMER__.selections.at(-1)"),
    await browser.evaluate(
      "({name:'first',start:__SELECTION_EDITOR__.selectionStart,end:__SELECTION_EDITOR__.selectionEnd})",
    ),
  );
  for (const type of ["keyDown", "keyUp"])
    await browser.call("Input.dispatchKeyEvent", {
      type,
      key: "ArrowLeft",
      code: "ArrowLeft",
      windowsVirtualKeyCode: 37,
    });
  await until(() => browser.evaluate("__KEYBOARD_CONSUMER__.selections.at(-1)?.start===10"));
  assert.deepEqual(await browser.evaluate("__KEYBOARD_CONSUMER__.selections.at(-1)"), {
    name: "first",
    start: 10,
    end: 10,
  });
  assert.equal(await browser.evaluate("__SELECTION_EDITOR__.selectionStart"), 10);
  await browser.evaluate("__SELECTION_EDITOR__.setSelectionRange(1,4)");
  await until(() =>
    browser.evaluate(
      "__KEYBOARD_CONSUMER__.selections.at(-1)?.start===1 && __KEYBOARD_CONSUMER__.selections.at(-1)?.end===4",
    ),
  );
  await browser.evaluate(
    "__KEYBOARD_CONSUMER__.write('A😀B');__SELECTION_EDITOR__.setSelectionRange(1,3)",
  );
  await until(() =>
    browser.evaluate(
      "__KEYBOARD_CONSUMER__.selections.at(-1)?.start===1 && __KEYBOARD_CONSUMER__.selections.at(-1)?.end===3",
    ),
  );
  assert.deepEqual(await browser.evaluate("[...__KEYBOARD_CONSUMER__.events]"), ["first:focus"]);
  await browser.evaluate("__KEYBOARD_CONSUMER__.dismiss()");
  await until(() => browser.evaluate("!document.querySelector('dialog')"));
  const retiredSelectionCount = await browser.evaluate("__KEYBOARD_CONSUMER__.selections.length");
  await browser.evaluate(
    "__SELECTION_EDITOR__.setSelectionRange(0,0);__SELECTION_EDITOR__.dispatchEvent(new Event('select'))",
  );
  assert.equal(
    await browser.evaluate("__KEYBOARD_CONSUMER__.selections.length"),
    retiredSelectionCount,
  );
  stage = "keyboard-live-edit-cancel";
  await browser.evaluate(
    "__KEYBOARD_CONSUMER__.events.length=0;__KEYBOARD_CONSUMER__.first();__KEYBOARD_CONSUMER__.clear()",
  );
  await browser.call("Input.insertText", { text: "Editing" });
  await until(() =>
    browser.evaluate("__KEYBOARD_CONSUMER__.events.includes('first:change:Editing')"),
  );
  assert.equal(await browser.evaluate("document.querySelector('dialog').open"), true);
  assert.deepEqual(await browser.evaluate("[...__KEYBOARD_CONSUMER__.events]"), [
    "first:focus",
    "first:change:Editing",
  ]);
  assert.ok(
    (await texts()).includes("•••••••"),
    "Secure live edits must remain masked outside the editor",
  );
  await browser.evaluate("document.querySelector('dialog button[type=button]').click()");
  await until(() => browser.evaluate("__KEYBOARD_CONSUMER__.events.includes('hide')"));
  assert.deepEqual(await browser.evaluate("[...__KEYBOARD_CONSUMER__.events]"), [
    "first:focus",
    "first:change:Editing",
    "first:blur",
    "hide",
  ]);
  await browser.evaluate("__KEYBOARD_CONSUMER__.first()");
  assert.equal(await browser.evaluate("document.querySelector('dialog input').value"), "Editing");
  await browser.evaluate("__KEYBOARD_CONSUMER__.dismiss()");
  await until(() => browser.evaluate("!document.querySelector('dialog')"));
  stage = "keyboard-live-controlled-format-and-reject";
  await browser.evaluate(
    "__KEYBOARD_CONSUMER__.reset('lower');__KEYBOARD_CONSUMER__.policy('uppercase')",
  );
  await until(() =>
    browser.evaluate(
      "__KEYBOARD_CONSUMER__.snapshot().value==='lower' && __KEYBOARD_CONSUMER__.snapshot().policy==='uppercase'",
    ),
  );
  await browser.evaluate(
    "__KEYBOARD_CONSUMER__.events.length=0;__KEYBOARD_CONSUMER__.controlled();globalThis.__EDITOR_NODE__=document.querySelector('dialog input');__EDITOR_NODE__.setSelectionRange(__EDITOR_NODE__.value.length,__EDITOR_NODE__.value.length)",
  );
  await browser.call("Input.insertText", { text: "x" });
  await until(() => browser.evaluate("document.querySelector('dialog input').value==='LOWERX'"));
  assert.equal(
    await browser.evaluate("document.querySelector('dialog input')===__EDITOR_NODE__"),
    true,
  );
  await browser.evaluate("__KEYBOARD_CONSUMER__.policy('reject')");
  await until(() => browser.evaluate("__KEYBOARD_CONSUMER__.snapshot().policy==='reject'"));
  await browser.call("Input.insertText", { text: "!" });
  await until(() =>
    browser.evaluate(
      "__KEYBOARD_CONSUMER__.events.includes('controlled:change:LOWERX!') && document.querySelector('dialog input').value==='LOWERX'",
    ),
  );
  assert.deepEqual(await browser.evaluate("[...__KEYBOARD_CONSUMER__.events]"), [
    "controlled:focus",
    "controlled:change:lowerx",
    "controlled:change:LOWERX!",
  ]);
  await browser.evaluate("document.querySelector('dialog form').requestSubmit()");
  await until(() => browser.evaluate("__KEYBOARD_CONSUMER__.events.includes('hide')"));
  assert.deepEqual(await browser.evaluate("[...__KEYBOARD_CONSUMER__.events]"), [
    "controlled:focus",
    "controlled:change:lowerx",
    "controlled:change:LOWERX!",
    "controlled:submit:LOWERX",
    "controlled:blur",
    "hide",
  ]);
  await browser.evaluate("delete globalThis.__EDITOR_NODE__");
  await browser.evaluate(
    "sessionStorage.setItem('roku-own-dev-session','fixture-approved-session')",
  );
  const start = Date.now();
  stage = "edit-reload";
  writeFileSync(app, withKeyboard(original.replace("Hello, Roku", "Hello, live Roku")));
  await until(async () => server.snapshot().generation >= 2);
  await until(async () => {
    const value = await texts();
    return value?.includes("Hello, live Roku");
  });
  const reloadMs = Date.now() - start;
  stage = "session-restoration";
  assert.equal(
    await browser.evaluate("sessionStorage.getItem('roku-own-dev-session')"),
    "fixture-approved-session",
  );
  stage = "compile-error-retains-app";
  writeFileSync(app, "export default function Broken( {");
  await until(() => server.snapshot().state === "error");
  assert.ok((await texts()).includes("Hello, live Roku"));
  assert.ok(await browser.evaluate("!document.querySelector('#roku-build-status').hidden"));
  stage = "compile-error-recovery";
  writeFileSync(app, withKeyboard(original.replace("Hello, Roku", "Hello, recovered Roku")));
  await until(async () => {
    const value = await texts();
    return value?.includes("Hello, recovered Roku");
  });
  stage = "activation-after-reload";
  await pause(150);
  await browser.evaluate(
    "window.__ROKU_DEV__.remote({key:'select',phase:'down'});window.__ROKU_DEV__.remote({key:'select',phase:'up'})",
  );
  await until(async () => {
    const value = await texts();
    return value?.some((text) => text.includes("Pressed 1 times"));
  });
  stage = "keyboard-retirement";
  const retirement = await browser.evaluate(`(async()=>{
    const api=__KEYBOARD_CONSUMER__;api.events.length=0;api.first();
    await window.__ROKU_DEV__.dispose();await new Promise(resolve=>setTimeout(resolve,30));
    return {events:api.events,dialogs:document.querySelectorAll('dialog').length,snapshot:window.__ROKU_DEV__.snapshot()};
  })()`);
  assert.deepEqual(retirement.events, ["first:focus"]);
  assert.equal(retirement.dialogs, 0);
  assert.equal(retirement.snapshot.nodes, 1);
  assert.equal(retirement.snapshot.listeners, 0);
  assert.deepEqual(retirement.snapshot.errors, []);
  assert.equal(await browser.evaluate("typeof globalThis.__RNR_COLUMNS_FIXTURE__"), "undefined");
  assert.equal(await browser.evaluate("typeof globalThis.__RNR_HORIZONTAL_FIXTURE__"), "undefined");
  assert.equal(await browser.evaluate("typeof globalThis.__RNR_IMAGE_LIFECYCLE__"), "undefined");
  assert.equal(await browser.evaluate("typeof globalThis.__RNR_MODAL_ORDER__"), "undefined");
  const result = {
    status: "passed",
    deviceQualified: false,
    browser: browser.version,
    archiveSha256: sdk.archiveSha256,
    reloadMs,
    generations: server.snapshot().generation,
    errorRecovery: true,
    sessionRetained: true,
    activationAfterReload: true,
    columns: {
      numColumns: 3,
      rectangles: columns,
      viewability: columnViewability,
      canvasSize,
      pixels: columnPixels,
      separators: {
        rectangles: separatorRectangles,
        before: separatorBefore,
        highlighted: separatorHighlighted,
        restored: true,
      },
      scope: "Committed Canvas host geometry; native scrolling/focus remain pending",
    },
    horizontal: {
      start: horizontalStart,
      end: horizontalEnd,
      tailPixel: horizontalPixels,
      boundaryStyles: { headerPixel: headerWrapperPixel, footerPixel: footerWrapperPixel },
      scope:
        "Committed Canvas single-axis geometry and retirement; no native scrolling/focus claim",
    },
    imageLifetimes: {
      sameUriRecycling: true,
      initial: imageInitial,
      recycled: imageRecycled,
      failed: imageFailed,
      recovered: imageRecovered,
      pixel: imagePixel,
      retiredRef: true,
      scope:
        "Actual browser decoding and Canvas host callbacks; native display/ordering remain pending",
    },
    modalPresentations: {
      closed: modalOrder.closed,
      red: modalRed,
      blue: modalBlue,
      scope:
        "Actual Canvas pixels and synthetic preview Back port; native modal/focus ordering remains pending",
    },
    tabularDigits: digitFaces,
    selectedFontRequests: fontRequests,
    textEntry: {
      submit: true,
      cancel: true,
      replacement: true,
      dismiss: true,
      controlledDraftUpdate: true,
      imperativeDraftUpdate: true,
      liveObservedChanges: true,
      observedSelection: true,
      domSelectionRanges: true,
      selectionRetirement: true,
      liveCancelPreservesChanges: true,
      controlledLiveFormatting: true,
      controlledLiveRejection: true,
      programmaticChangesDoNotEmitInput: true,
      emailDomain: true,
      remoteIsolation: true,
      retirement,
    },
    scope:
      "Generated app, packed platform, browser Canvas host; full reload rather than React Fast Refresh",
  };
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    resolve(evidence, "development-proof.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (error) {
  const failure = {
    status: "failed",
    deviceQualified: false,
    archiveSha256: sdk.archiveSha256,
    stage,
    error: error instanceof Error ? error.message : String(error),
    build: server?.snapshot(),
    recentBuildEvents: events.slice(-32),
    browser: browser?.diagnostics(),
  };
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    resolve(evidence, "development-failure-proof.json"),
    JSON.stringify(failure, null, 2) + "\n",
  );
  console.error(JSON.stringify(failure));
  throw error;
} finally {
  await browser?.close();
  await server?.close();
  writeFileSync(app, original);
}
