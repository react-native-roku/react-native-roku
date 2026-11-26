import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Parser, ParseMode } from "brighterscript";
import { build } from "esbuild";
import ts from "typescript";
import { packageRoot } from "../build/index.mjs";
import { ensureQualificationStorage } from "./qualificationStorage.mjs";
await ensureQualificationStorage({ projectRoot: packageRoot });
const temporary = mkdtempSync(resolve(tmpdir(), "react-native-roku-sdk-"));
const evidence = resolve(process.env.ROKU_QUALIFY_EVIDENCE_DIR ?? resolve(packageRoot, ".local"));
const archive = process.env.ROKU_QUALIFY_ARCHIVE
  ? resolve(process.env.ROKU_QUALIFY_ARCHIVE)
  : resolve(temporary, "platform.tgz");
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CI: "1" },
  });
  if (result.status !== 0) throw Error(result.stdout + "\n" + result.stderr);
  return result.stdout;
}
if (!process.env.ROKU_QUALIFY_ARCHIVE) run("pnpm", ["pack", "--out", archive], packageRoot);
const consumer = resolve(temporary, "hello");
const unpacked = resolve(temporary, "unpacked");
mkdirSync(unpacked);
run("tar", ["-xzf", archive, "-C", unpacked], temporary);
run(
  process.execPath,
  [
    resolve(unpacked, "package/bin/react-native-roku.mjs"),
    "init",
    consumer,
    `--package=file:${archive}`,
  ],
  temporary,
);
run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], consumer);
copyFileSync(
  resolve(packageRoot, "examples/minimal/src/modalOrderFixture.tsx"),
  resolve(consumer, "src/ModalOrderFixture.tsx"),
);
const appPath = resolve(consumer, "src/App.tsx");
const templateApp = readFileSync(appPath, "utf8");
assert.match(templateApp, /export default function App\(/);
copyFileSync(
  resolve(packageRoot, "examples/minimal/src/columnsFixture.tsx"),
  resolve(consumer, "src/ColumnsFixture.tsx"),
);
copyFileSync(
  resolve(packageRoot, "examples/minimal/src/horizontalFixture.tsx"),
  resolve(consumer, "src/HorizontalFixture.tsx"),
);
copyFileSync(
  resolve(packageRoot, "examples/minimal/src/imageLifecycleFixture.tsx"),
  resolve(consumer, "src/ImageLifecycleFixture.tsx"),
);
writeFileSync(
  appPath,
  'import {ModalOrderFixture} from "./ModalOrderFixture";\nimport {ImageLifecycleFixture} from "./ImageLifecycleFixture";\nimport {HorizontalFixture} from "./HorizontalFixture";\nimport {ColumnsFixture} from "./ColumnsFixture";\nimport {SceneGraphAudio,SceneGraphVideo} from "react-native-roku/media";\nimport {Text as ParagraphText,TextInput as ConsumerInput,Pressable as ConsumerPressable,View as ConsumerView} from "react-native";\n' +
    templateApp.replace("export default function App(", "function BaseApp(") +
    '\nexport default function AudioConsumer(){return <><BaseApp/><ParagraphText role="heading" aria-level={3} aria-roledescription="section heading" style={{width:180,fontSize:20,lineHeight:28}}>Open <ParagraphText style={{color:"red"}}>a shared styled paragraph</ParagraphText> in this app.</ParagraphText><ConsumerInput defaultValue="Shared input" secureTextEntry aria-invalid /><ConsumerPressable role="button" accessibilityLabel="Choose profile" aria-haspopup="dialog"/><ConsumerPressable role="link" accessibilityLabel="Library" aria-current="page"/><ConsumerView role="separator" accessibilityLabel="Resize" aria-orientation="vertical"/><ColumnsFixture/><HorizontalFixture/><ImageLifecycleFixture/><ModalOrderFixture/><SceneGraphAudio source={{uri:"https://fixture.invalid/audio",format:"mp3"}} paused /><SceneGraphVideo source={{uri:"https://fixture.invalid/video.m3u8",format:"hls"}} paused /></>;}\n',
);
run(
  process.execPath,
  [resolve(consumer, "node_modules/typescript/bin/tsc6"), "--noEmit", "-p", "tsconfig.react.json"],
  consumer,
);
const cli = resolve(consumer, "node_modules/react-native-roku/bin/react-native-roku.mjs");
const doctor = JSON.parse(run("pnpm", ["--silent", "run", "doctor"], consumer));
assert.equal(doctor.status, "passed");
assert.ok(doctor.checks.some((check) => check.name === "configuration and entry"));
const sdkLog = run(process.execPath, [cli, "build"], consumer);
const config = JSON.parse(readFileSync(resolve(consumer, "roku.config.json")));
const consumerRequire = createRequire(resolve(consumer, "package.json"));
const project = await import(
  pathToFileURL(consumerRequire.resolve("react-native-roku/build/project")).href
);
const productionProfile = JSON.parse(readFileSync(resolve(consumer, ".roku/build-profile.json")));
assert.equal(productionProfile.profile, "production");
const emittedReact = (directory, profile) => {
  const meta = JSON.parse(readFileSync(resolve(directory, "src/generated/frontend.metafile.json")));
  const bytes = (suffix) =>
    Object.values(meta.outputs)
      .flatMap((output) => Object.entries(output.inputs))
      .filter(([path]) => path.endsWith(suffix))
      .reduce((sum, [, value]) => sum + value.bytesInOutput, 0);
  assert.ok(bytes("react." + profile + ".js") > 0);
  assert.equal(
    bytes("react." + (profile === "production" ? "development" : "production") + ".js"),
    0,
  );
};
emittedReact(resolve(consumer, ".roku"), "production");
const development = await project.prepareRokuProject(consumer, { profile: "development" });
assert.equal(development.profile, "development");
emittedReact(development.directory, "development");
assert.deepEqual(
  JSON.parse(readFileSync(resolve(consumer, ".roku/build-profile.json"))),
  productionProfile,
);

mkdirSync(evidence, { recursive: true });
writeFileSync(resolve(evidence, "sdk-consumer-build.log"), sdkLog);
const bundle = resolve(consumer, ".roku/dist/sdk/bundle");
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(resolve(directory, entry.name)) : [resolve(directory, entry.name)],
  );
const files = walk(bundle).map((path) => relative(bundle, path).split("\\").join("/"));
for (const path of [
  "manifest",
  "source/Main.brs",
  "source/compiled/index.js",
  `components/${config.name}Scene.xml`,
])
  assert.ok(files.includes(path), path);
for (const name of [
  "RNRAppControl",
  "RNRTextRaster",
  "RNRTextRasterTask",
  "RNRDeviceFacts",
  "RNRDeviceFactsTask",
])
  for (const extension of ["xml", "brs"])
    assert.ok(files.includes(`components/${name}.${extension}`));
const cornerAssets = files.filter((path) => /corner-[0-3]\.png$/.test(path)).sort();
assert.deepEqual(
  cornerAssets.map((path) => path.split("/").at(-1)),
  [0, 1, 2, 3].map((index) => `corner-${index}.png`),
  "Packed SDK consumer must ship all four default rounded clipping masks",
);
assert.match(
  readFileSync(resolve(consumer, ".roku/src/generated/RokuAnchor.ts"), "utf8"),
  /cornerMasks,/,
);
assert.ok(files.some((path) => path.startsWith("fonts/") && path.endsWith(".ttf")));
assert.ok(
  files.filter((path) => path.startsWith("fonts/") && path.endsWith(".ttf")).length >= 8,
  "Packed SDK consumer lost its regular/bold/italic or variant font assets",
);
assert.match(
  readFileSync(resolve(consumer, ".roku/src/generated/fontAssets.ts"), "utf8"),
  /InterRegular::tabular-nums/,
);
assert.match(
  readFileSync(resolve(consumer, ".roku/src/generated/RokuAnchor.ts"), "utf8"),
  /families:\{"Inter":\{"normal":\{"400":"InterRegular","700":"InterBold"\},"italic":\{"400":"InterItalic","700":"InterBoldItalic"\}\}\}/,
);
const program = readFileSync(resolve(bundle, "source/compiled/index.js"), "utf8");
assert.ok(program.includes(`${config.name}Anchor`));
assert.ok(program.includes("C31_AUDIO_FORMAT"), "Packed audio frontend must reach SDK compilation");
assert.ok(
  program.includes("fixture-columns"),
  "The bounded column fixture must reach SDK compilation",
);

const native = files.filter((path) => path.endsWith(".brs"));
for (const path of native)
  assert.deepEqual(
    Parser.parse(readFileSync(resolve(bundle, path), "utf8"), {
      mode: ParseMode.BrightScript,
      minFirmwareVersion: "16.0.0",
    }).diagnostics,
    [],
    path,
  );
const graph = JSON.parse(
  readFileSync(resolve(consumer, ".roku/src/generated/frontend.metafile.json")),
);
const inputs = Object.keys(graph.inputs);
assert.equal(inputs.filter((path) => path.endsWith("react/cjs/react.production.js")).length, 1);
assert.equal(inputs.filter((path) => path.endsWith("react/cjs/react.development.js")).length, 0);
assert.ok(inputs.some((path) => path.includes("react-native-roku/src/react-native/primitives.ts")));
assert.ok(!inputs.some((path) => /node_modules\/react-native(?:-tvos|-web)?\//.test(path)));
const occupied = createServer();
await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
try {
  const failure = spawnSync(process.execPath, [cli, "dev"], {
    cwd: consumer,
    encoding: "utf8",
    timeout: 45000,
    env: { ...process.env, CI: "1", ROKU_DEV_PORT: String(occupied.address().port) },
  });
  assert.equal(failure.status, 1, failure.stdout + failure.stderr);
  assert.match(failure.stderr, /EADDRINUSE/);
  assert.deepEqual(
    readdirSync(resolve(consumer, ".roku/dev")),
    [],
    "Failed development startup must retire its owned workspace",
  );
} finally {
  await new Promise((resolve) => occupied.close(resolve));
}
const zip = resolve(temporary, "hello-react-native-roku.zip");
run("zip", ["-q", "-r", zip, "."], bundle);
run("unzip", ["-tqq", zip], consumer);
const savedZip = process.env.ROKU_QUALIFY_EVIDENCE_DIR
  ? resolve(evidence, "hello-react-native-roku.zip")
  : resolve(packageRoot, "dist/hello-react-native-roku.zip");
mkdirSync(resolve(packageRoot, "dist"), { recursive: true });
copyFileSync(zip, savedZip);
const sdkServices = await qualifySdkServices();
const sdkObservers = await qualifySdkObserverLifetimes();
const result = {
  status: "passed",
  audioCompiled: true,
  deviceQualified: false,
  consumer,
  archive,
  archiveSha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
  zip: savedZip,
  zipSha256: createHash("sha256").update(readFileSync(zip)).digest("hex"),
  files: files.length,
  nativeSyntaxFiles: native.length,
  reactCopies: 1,
  sourceImports: "public package exports",
  sdk: "2.19.1",
  application: config.name,
  failedDevelopmentStartCleaned: true,
  sdkServices,
  sdkObservers,
};
mkdirSync(evidence, { recursive: true });
writeFileSync(resolve(evidence, "sdk-consumer-proof.json"), JSON.stringify(result, null, 2) + "\n");
writeFileSync(resolve(evidence, "sdk-consumer-build.log"), sdkLog);
console.log(JSON.stringify(result));

async function qualifySdkServices() {
  const directory = mkdtempSync(resolve(evidence, "sdk-services-"));
  const entry = 'export { createSdkDeviceServices } from "react-native-roku/sdk-services";';
  writeFileSync(resolve(directory, "entry.ts"), entry);
  const compiled = await build({
    stdin: { contents: entry, sourcefile: "sdk-services-entry.ts", resolveDir: consumer },
    absWorkingDir: consumer,
    bundle: true,
    format: "cjs",
    platform: "node",
    sourcemap: true,
    metafile: true,
    define: { __BASE_LOG_LEVEL__: '"INFO"', __CURRENT_LOG_LEVEL__: '"ERROR"' },
    outfile: resolve(directory, "program.cjs"),
  });
  writeFileSync(
    resolve(directory, "metafile.json"),
    JSON.stringify(compiled.metafile, null, 2) + "\n",
  );
  const captured = [];
  for (const name of Object.keys(compiled.metafile.inputs)) {
    const source = isAbsolute(name) ? name : resolve(consumer, name);
    if (source === resolve(consumer, "sdk-services-entry.ts")) {
      assert.equal(compiled.metafile.inputs[name].bytes, Buffer.byteLength(entry));
      continue;
    }
    const path = `inputs/${captured.length}.source`;
    mkdirSync(dirname(resolve(directory, path)), { recursive: true });
    copyFileSync(source, resolve(directory, path));
    captured.push({ source, path, sha256: digest(resolve(directory, path)) });
  }
  const publicFactory = realpathSync(consumerRequire.resolve("react-native-roku/sdk-services"));
  assert.ok(captured.some(({ source }) => realpathSync(source) === publicFactory));
  writeFileSync(resolve(directory, "inputs.json"), JSON.stringify(captured, null, 2) + "\n");
  const runner = resolve(directory, "runner.mjs");
  writeFileSync(
    runner,
    'import assert from "node:assert/strict";\nimport { createRequire } from "node:module";\n' +
      `console.log(JSON.stringify(await (${sdkServiceFixture.toString()})()));\n`,
  );
  const runnerSha256 = digest(runner);
  const programSha256 = digest(resolve(directory, "program.cjs"));
  const stdout = run(process.execPath, [runner], consumer);
  writeFileSync(resolve(directory, "stdout.log"), stdout);
  const proof = JSON.parse(stdout);
  assert.equal(proof.status, "passed");
  assert.equal(proof.deviceQualified, false);
  for (const input of captured) {
    assert.equal(digest(input.source), input.sha256);
    assert.equal(digest(resolve(directory, input.path)), input.sha256);
  }
  assert.equal(digest(runner), runnerSha256);
  assert.equal(digest(resolve(directory, "program.cjs")), programSha256);
  const result = {
    ...proof,
    directory,
    archiveSha256: digest(archive),
    sourceInputs: captured.length,
    runnerSha256,
    programSha256,
  };
  writeFileSync(resolve(directory, "proof.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Executed in a fresh Node child against the installed public factory and actual
// pinned SDK wrappers. Every native host below is synthetic, including crypto.
async function sdkServiceFixture() {
  const buffered = new Map(),
    durable = new Map(),
    calls = [],
    checks = [];
  let encryptionFailure = false,
    emptyEncryption = false,
    emptyDecryption = false,
    flushes = 0;
  const outcomes = [];
  const registry = {
    create(section) {
      return {
        read: (key) => buffered.get(`${section}/${key}`) ?? null,
        exists: (key) => buffered.has(`${section}/${key}`),
        write(key, value) {
          buffered.set(`${section}/${key}`, value);
          return true;
        },
        delete: (key) => buffered.delete(`${section}/${key}`),
      };
    },
    async flush() {
      flushes++;
      if (!(outcomes.shift() ?? true)) return false;
      durable.clear();
      for (const pair of buffered) durable.set(...pair);
      return true;
    },
  };
  globalThis.roku = {
    getRuntimeSingleton: async (name) => {
      assert.equal(name, "Registry");
      return registry;
    },
    getRuntimeSingletonSync(name) {
      if (name === "LoggerAPI") return { getLoggerRef: () => 0, logDevConsole() {} };
      assert.equal(name, "DeviceInfo");
      return { getRandomUUID: () => "00000000-0000-4000-8000-000000000007" };
    },
    LogLevel: { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4 },
    DeviceCryptoHostFunc: () => ({
      encrypt(data, type) {
        assert.equal(type, "device");
        calls.push({ operation: "encrypt", bytes: data.byteLength });
        if (encryptionFailure) throw Error("Synthetic encryption unavailable");
        if (emptyEncryption) return new ArrayBuffer(0);
        const input = new Uint8Array(data),
          output = new Uint8Array(input.length + 1);
        output[0] = 171;
        for (let index = 0; index < input.length; index++) output[index + 1] = input[index] ^ 90;
        return output.buffer;
      },
      decrypt(data, type) {
        assert.equal(type, "device");
        calls.push({ operation: "decrypt", bytes: data.byteLength });
        if (emptyDecryption) return new ArrayBuffer(0);
        const input = new Uint8Array(data);
        assert.equal(input[0], 171);
        return input.slice(1).map((value) => value ^ 90).buffer;
      },
    }),
    crypto: { getRandomBytes: (length) => new Uint8Array(length).fill(7).buffer },
  };
  try {
    const { createSdkDeviceServices } = createRequire(import.meta.url)("./program.cjs");
    const first = await createSdkDeviceServices({ namespace: "fixture-first" });
    const second = await createSdkDeviceServices({ namespace: "fixture-second" });
    for (const value of ["synthetic-🪵-credential", "", "\u0000embedded\u0000", "\ud800"]) {
      await first.storage.write("secure", "credential", value);
      assert.equal(await first.storage.read("secure", "credential"), value);
      assert.equal(await second.storage.read("secure", "credential"), null);
      assert.match(durable.get("fixture-first-secure/credential"), /^pdr2:/);
      assert.ok(calls.at(-2).bytes > 0);
    }
    checks.push("device-key-dispatch-string-domain-and-namespace-isolation");
    const before = flushes,
      ciphertext = buffered.get("fixture-first-secure/credential");
    encryptionFailure = true;
    await assert.rejects(
      first.storage.write("secure", "credential", "replacement"),
      /Synthetic encryption unavailable/,
    );
    encryptionFailure = false;
    emptyEncryption = true;
    await assert.rejects(
      first.storage.write("secure", "credential", "replacement"),
      /C21_SECRET_STORAGE/,
    );
    emptyEncryption = false;
    assert.equal(flushes, before);
    assert.equal(buffered.get("fixture-first-secure/credential"), ciphertext);
    checks.push("no-replacement-or-flush-on-failed-or-empty-encryption");
    outcomes.push(false, true);
    await assert.rejects(
      first.storage.write("secure", "credential", "replacement"),
      /C21_STORAGE_FLUSH/,
    );
    assert.equal(buffered.get("fixture-first-secure/credential"), ciphertext);
    assert.equal(durable.get("fixture-first-secure/credential"), ciphertext);
    assert.equal(await first.storage.read("secure", "credential"), "\ud800");
    checks.push("failed-flush-restores-previous-ciphertext-and-queue");
    const legacy = globalThis.roku
      .DeviceCryptoHostFunc()
      .encrypt(new TextEncoder().encode("legacy-🪵").buffer, "device");
    const legacyCipher = "pdr1:" + Buffer.from(legacy).toString("hex");
    buffered.set("fixture-first-secure/legacy", legacyCipher);
    const legacyFlushes = flushes;
    assert.equal(await first.storage.read("secure", "legacy"), "legacy-🪵");
    assert.equal(flushes, legacyFlushes);
    assert.equal(buffered.get("fixture-first-secure/legacy"), legacyCipher);
    checks.push("legacy-credential-read-without-migration");
    for (const value of ["plaintext", "pdr1:", "pdr1:xx", "pdr2:", "pdr2:xx", "pdr3:07"]) {
      buffered.set("fixture-first-secure/damaged", value);
      const count = calls.length;
      await assert.rejects(first.storage.read("secure", "damaged"), /C21_SECRET_STORAGE/);
      assert.equal(calls.length, count);
    }
    emptyDecryption = true;
    await assert.rejects(first.storage.read("secure", "credential"), /C21_SECRET_STORAGE/);
    emptyDecryption = false;
    assert.equal(await first.storage.read("secure", "credential"), "\ud800");
    checks.push("malformed-data-and-empty-decryption-fail-without-empty-value-fallback");
    const reopened = await createSdkDeviceServices({ namespace: "fixture-first" });
    assert.equal(await reopened.storage.read("secure", "credential"), "\ud800");
    await reopened.storage.write("secure", "credential", null);
    assert.equal(await first.storage.read("secure", "credential"), null);
    checks.push("fresh-service-instance-and-deletion-through-shared-registry-port");
    assert.deepEqual([...first.randomBytes(3)], [7, 7, 7]);
    assert.equal(first.randomUUID(), "00000000-0000-4000-8000-000000000007");
    globalThis.roku.crypto = undefined;
    assert.throws(() => first.randomBytes(3), /not available/);
    checks.push("actual-sdk-random-binding-and-missing-host-refusal");
    return {
      status: "passed",
      deviceQualified: false,
      checks,
      calls,
      flushes,
      scope:
        "Installed archive public sdk-services factory and pinned SDK wrappers; synthetic native Registry/DeviceCrypto/RNG ports only. No hardware protection, persistence or firmware qualification.",
    };
  } finally {
    delete globalThis.roku;
  }
}

// Execute installed public native bridges against the exact pinned SDK property
// function. The Tree API ports and timers below are explicit synthetic mechanics.
async function qualifySdkObserverLifetimes() {
  const directory = mkdtempSync(resolve(evidence, "sdk-observers-"));
  const producerRequire = createRequire(import.meta.url),
    compilerPath = producerRequire.resolve("typescript"),
    compilerSha256 = digest(compilerPath);
  let solidRoot = dirname(consumerRequire.resolve("@roku-sdk/solid"));
  while (
    !existsSync(resolve(solidRoot, "package.json")) ||
    JSON.parse(readFileSync(resolve(solidRoot, "package.json"))).name !== "@roku-sdk/solid"
  ) {
    const parent = dirname(solidRoot);
    assert.notEqual(parent, solidRoot, "Pinned SDK package root missing");
    solidRoot = parent;
  }
  const solidPath = resolve(solidRoot, "src/solid.ts"),
    solidSource = readFileSync(solidPath, "utf8"),
    sdkPackagePath = resolve(solidRoot, "package.json"),
    sdkPackage = JSON.parse(readFileSync(sdkPackagePath));
  assert.equal(sdkPackage.version, "2.19.1");
  const sdkSourceSha256 = createHash("sha256").update(solidSource).digest("hex");
  const ast = ts.createSourceFile(
    solidPath,
    solidSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const functions = {};
  let setter;
  for (const statement of ast.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      ["isEventHandler", "transformEventName"].includes(statement.name?.text)
    )
      functions[statement.name.text] = statement.getText(ast);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (
          declaration.name.getText(ast) === "tmTransaction" &&
          declaration.initializer &&
          ts.isObjectLiteralExpression(declaration.initializer)
        ) {
          const property = declaration.initializer.properties.find(
            (property) => property.name?.getText(ast) === "setProperty",
          );
          if (
            property &&
            ts.isPropertyAssignment(property) &&
            ts.isArrowFunction(property.initializer)
          )
            setter = property.initializer.getText(ast);
        }
      }
  }
  assert.ok(
    setter && functions.isEventHandler && functions.transformEventName,
    "Pinned SDK property source shape changed",
  );
  const bridge =
      sdkObserverBoundary() +
      "\n" +
      functions.isEventHandler +
      "\n" +
      functions.transformEventName +
      "\nexport const tmTransaction={setProperty:" +
      setter +
      "};\n",
    entry = sdkObserverProgram(),
    transaction = "export const transactionManager={startTransaction(){}};";
  const fixtureFiles = { "bridge.ts": bridge, "entry.ts": entry, "transaction.ts": transaction };
  for (const [name, contents] of Object.entries(fixtureFiles))
    writeFileSync(resolve(directory, name), contents);
  copyFileSync(solidPath, resolve(directory, "pinned-solid.ts"));
  assert.equal(digest(resolve(directory, "pinned-solid.ts")), sdkSourceSha256);
  copyFileSync(sdkPackagePath, resolve(directory, "pinned-sdk-package.json"));
  const compiled = await build({
    stdin: { contents: entry, resolveDir: consumer, sourcefile: "sdk-observers-entry.ts" },
    absWorkingDir: consumer,
    bundle: true,
    format: "iife",
    platform: "neutral",
    target: "es2019",
    metafile: true,
    sourcemap: true,
    outfile: resolve(directory, "program.js"),
    plugins: [
      {
        name: "pinned-sdk-observer-boundary",
        setup(builder) {
          builder.onResolve({ filter: /^(?:@roku-sdk\/solid|sdk-observer-boundary)$/ }, () => ({
            path: "solid",
            namespace: "sdk-observer-fixture",
          }));
          builder.onResolve({ filter: /^@roku-sdk\/common\/transaction$/ }, () => ({
            path: "transaction",
            namespace: "sdk-observer-fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "sdk-observer-fixture" }, (args) => ({
            contents: args.path === "solid" ? bridge : transaction,
            loader: "ts",
          }));
        },
      },
    ],
  });
  writeFileSync(
    resolve(directory, "metafile.json"),
    JSON.stringify(compiled.metafile, null, 2) + "\n",
  );
  const captured = [];
  for (const name of Object.keys(compiled.metafile.inputs)) {
    if (name.startsWith("sdk-observer-fixture:") || name === "sdk-observers-entry.ts") continue;
    const source = isAbsolute(name) ? name : resolve(consumer, name);
    assert.ok(existsSync(source), "Uncaptured SDK observer input: " + name);
    const path = "input-" + captured.length + ".source";
    copyFileSync(source, resolve(directory, path));
    captured.push({ source, path, sha256: digest(source) });
  }
  for (const specifier of [
    "react-native-roku/sdk-device-facts",
    "react-native-roku/sdk-text-raster",
  ])
    assert.ok(
      captured.some(
        (input) => realpathSync(input.source) === realpathSync(consumerRequire.resolve(specifier)),
      ),
      specifier,
    );
  const pinned = [
    { source: solidPath, path: "pinned-solid.ts", sha256: digest(solidPath) },
    { source: sdkPackagePath, path: "pinned-sdk-package.json", sha256: digest(sdkPackagePath) },
  ];
  const fixtures = Object.entries(fixtureFiles).map(([path, contents]) => ({
    path,
    sha256: createHash("sha256").update(contents).digest("hex"),
  }));
  for (const fixture of fixtures)
    assert.equal(digest(resolve(directory, fixture.path)), fixture.sha256);
  writeFileSync(
    resolve(directory, "inputs.json"),
    JSON.stringify({ archiveInputs: captured, primarySdkInputs: pinned, fixtures }, null, 2) + "\n",
  );
  // The pinned host Hermes accepts the lowered language profile. Node executes
  // these same bytes so the two engines cannot accidentally test different code.
  const lowered = ts.transpileModule(readFileSync(resolve(directory, "program.js"), "utf8"), {
    fileName: "sdk-observer-program.js",
    compilerOptions: {
      allowJs: true,
      target: ts.ScriptTarget.ES5,
      downlevelIteration: true,
      inlineSourceMap: true,
      inlineSources: true,
      ignoreDeprecations: "6.0",
    },
  });
  assert.ok(lowered.outputText);
  writeFileSync(resolve(directory, "program-host.js"), lowered.outputText);
  const programSha256 = digest(resolve(directory, "program-host.js")),
    records = [];
  const commands = [["node", process.execPath, [resolve(directory, "program-host.js")]]];
  if (process.env.ROKU_HERMES_EXECUTABLE)
    commands.push([
      "hermes",
      resolve(process.env.ROKU_HERMES_EXECUTABLE),
      ["-w", "-Xes6-promise", "-Xmicrotask-queue", "-exec", resolve(directory, "program-host.js")],
    ]);
  for (const [name, executable, args] of commands) {
    const executableSha256 = digest(executable);
    const execution = spawnSync(executable, args, {
      cwd: consumer,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    writeFileSync(resolve(directory, name + "-stdout.log"), execution.stdout ?? "");
    writeFileSync(resolve(directory, name + "-stderr.log"), execution.stderr ?? "");
    const line = (execution.stdout ?? "")
      .split("\n")
      .find((line) => line.startsWith("RNR_SDK_OBSERVERS_PROOF:"));
    const result = line ? JSON.parse(line.slice("RNR_SDK_OBSERVERS_PROOF:".length)) : undefined;
    records.push({
      name,
      executable,
      executableSha256,
      exitCode: execution.status,
      ...(result ?? { status: "failed", error: execution.error?.message ?? "No terminal proof" }),
    });
    writeFileSync(resolve(directory, "runs.json"), JSON.stringify(records, null, 2) + "\n");
    assert.equal(digest(executable), executableSha256);
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(result?.status, "passed", JSON.stringify(records.at(-1)));
    assert.equal(result.deviceQualified, false);
  }
  for (const input of [...captured, ...pinned]) {
    assert.equal(digest(input.source), input.sha256);
    assert.equal(digest(resolve(directory, input.path)), input.sha256);
  }
  for (const fixture of fixtures)
    assert.equal(digest(resolve(directory, fixture.path)), fixture.sha256);
  assert.equal(digest(resolve(directory, "program-host.js")), programSha256);
  assert.equal(digest(compilerPath), compilerSha256);
  const result = {
    status: "passed",
    deviceQualified: false,
    directory,
    archiveSha256: digest(archive),
    records,
    hermes: { status: commands.length === 2 ? "passed" : "not-requested" },
    sourceInputs: captured.length,
    primarySdk: { version: sdkPackage.version, sourceSha256: digest(solidPath) },
    programSha256,
    esbuildProgramSha256: digest(resolve(directory, "program.js")),
    bridgeSha256: digest(resolve(directory, "bridge.ts")),
    lowering: {
      compiler: "typescript",
      version: ts.version,
      compilerSha256,
      target: "ES5",
      sameProgramBytes: true,
    },
    scope:
      "Installed public DeviceFacts/raster bridges and actual pinned SDK property implementation; synthetic Tree API field/registration/timer ports. Native task execution, timing and physical cleanup remain pending.",
  };
  writeFileSync(resolve(directory, "proof.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

function sdkObserverProgram() {
  return String.raw`
import {SdkDeviceFacts} from 'react-native-roku/sdk-device-facts';
import {SdkTextRasterTransport} from 'react-native-roku/sdk-text-raster';
import {boundary} from 'sdk-observer-boundary';
const timers=new Map();let timerID=0;
globalThis.setTimeout=(work,delay)=>{const id=++timerID;timers.set(id,{work,delay});return id};
globalThis.clearTimeout=id=>timers.delete(id);
const demand=(value,message)=>{if(!value)throw Error(message)};
const drain=async()=>{for(let i=0;i<8;i++)await Promise.resolve()};
const rejected=async(promise,expected)=>{let error;try{await promise}catch(value){error=value}demand(error===expected||(typeof expected==='string'&&String(error).includes(expected)),'Rejection changed: '+String(error));};
async function qualify(){
 const checks=[];
 const node={r:1,t:'facts'};
 const facts=new SdkDeviceFacts(node,()=>{},()=>{}), events=[];
 const old=facts.addListener('onAudioRouteChanged',()=>events.push('old'));old.remove();
 facts.addListener('onAudioRouteChanged',()=>events.push('current'));old.remove();
 boundary.emit(node,'event',JSON.stringify({type:'capabilities',routeEpoch:2}));
 demand(events.join(',')==='current','Retired remove callback deleted the replacement subscriber');
 facts.dispose();demand(boundary.registrations.size===0,'Facts cleanup did not submit actual SDK unregister cues');
 checks.push('pinned-sdk-handler-unregister-and-replacement-subscription');
 for(const [index,type] of ['capabilities','memory'].entries()){
  const node={r:2+index,t:'facts'},facts=new SdkDeviceFacts(node,()=>{},()=>{});let later=0;
  const name=type==='memory'?'onResourcePressure':'onAudioRouteChanged';
  facts.addListener(name,()=>facts.dispose());facts.addListener(name,()=>later++);
  boundary.emit(node,'event',JSON.stringify({type,level:'critical',routeEpoch:3}));
  demand(later===0&&boundary.registrations.size===0,'Retired facts event chain continued');
 }
 checks.push('reentrant-facts-observation-retirement');
 const node2={r:10,t:'raster'},raster=new SdkTextRasterTransport(node2,{Body:'pkg:/body.ttf'},'fixture');
 const failure=Error('Synthetic request submission failed');boundary.faults.set('string:request',failure);
 const first=raster.delete('tmp:/failed.png'),second=raster.delete('tmp:/current.png');
 await rejected(first,failure);await drain();
 const current=JSON.parse(boundary.get(node2,'request'));
 boundary.emit(node2,'reply',JSON.stringify({id:current.id-1}));boundary.emit(node2,'reply',JSON.stringify({id:current.id}));
 await second;demand(timers.size===0,'Failed RPC predecessor left an owned timer');raster.dispose();
 demand(boundary.registrations.size===0,'Raster observer did not unregister');
 checks.push('failed-request-timer-and-current-reply-ownership');
 const node3={r:11,t:'raster'},cleanup=new SdkTextRasterTransport(node3,{Body:'pkg:/body.ttf'},'cleanup');
 const primary=Error('Synthetic dispose submission failed'),secondary=Error('Synthetic observer detach failed');
 boundary.faults.set('string:request',primary);boundary.faults.set('unregister:reply',secondary);
 let error;try{cleanup.dispose()}catch(value){error=value}demand(error===primary,'Later cleanup replaced the first error');
 cleanup.dispose();cleanup.dispose();
 const accepted=boundary.calls.filter(call=>call.node===11&&call.operation==='string'&&call.name==='request'&&JSON.parse(call.value).type==='dispose');
 demand(accepted.length===1&&boundary.registrations.size===0,'Failed cleanup lost authority or replayed an accepted step');
 await rejected(cleanup.delete('tmp:/retired.png'),'retired');
 checks.push('failed-dispose-and-unregister-step-retry');
 const node4={r:12,t:'raster'},fonts={Body:'pkg:/original.ttf'},captured=new SdkTextRasterTransport(node4,fonts,'font-identity');
 fonts.Body='pkg:/replacement.ttf';
 const pendingMask=captured.mask({fontFamily:'Body',width:1,height:1,fontSize:20,lineHeight:20,commands:[{text:'a',x:0,y:0}],inset:0,scale:1,color:'white',shadowColor:'transparent',shadowX:0,shadowY:0,shadowRadius:0});
 await drain();demand(JSON.parse(boundary.get(node4,'request')).font==='pkg:/original.ttf','A caller map edit changed the captured physical font');
 captured.dispose();await rejected(pendingMask,'retired');
 checks.push('captured-font-request-identity');
 demand(timers.size===0,'Owned timers remain');
 return{status:'passed',deviceQualified:false,checks,registrations:boundary.registrations.size,timers:timers.size,scope:'Installed public SDK bridges and actual pinned SDK setProperty function; synthetic Tree API field/registration/timer ports. Native task execution and firmware cleanup remain pending.'};
}
const emit=typeof print==='function'?print:console.log;
qualify().then(value=>emit('RNR_SDK_OBSERVERS_PROOF:'+JSON.stringify(value)),error=>emit('RNR_SDK_OBSERVERS_PROOF:'+JSON.stringify({status:'failed',error:String(error),registrations:boundary.registrations.size,timers:timers.size})));
`;
}

function sdkObserverBoundary() {
  return String.raw`
const interned=new Map();
const stringInterner={internString(value){if(!interned.has(value))interned.set(value,{name:value});return interned.get(value)}};
const isEventHandlerCache=new Map(),eventNameTransformCache=new Map(),observerCallbacks=new Map();
const NO_ANCHOR={fixture:true},nodesToRemove=new Set();
const unavailable=()=>{throw Error('Unadmitted Tree API operation in observer fixture')};
const createFullArray=unavailable,createFullObject=unavailable,isDomNode=unavailable,requestFocus=unavailable,releaseFocus=unavailable;
const solidLogger={trace(){}};
const fields=new Map(),registrations=new Set(),faults=new Map(),calls=[];
const key=(node,name)=>String(node)+':'+name;
function fail(operation,name){const failure=faults.get(operation+':'+name);if(failure){faults.delete(operation+':'+name);throw failure}}
const tmApi={
 setNodePropString(_anchor,node,prop,value){fail('string',prop.name);fields.set(key(node,prop.name),value);calls.push({operation:'string',node,name:prop.name,value})},
 registerFieldChangeHandler(_anchor,node,prop){fail('register',prop.name);registrations.add(key(node,prop.name));calls.push({operation:'register',node,name:prop.name})},
 unregisterFieldHandler(_anchor,node,prop){fail('unregister',prop.name);registrations.delete(key(node,prop.name));calls.push({operation:'unregister',node,name:prop.name})},
 setNodePropBool:unavailable,setNodePropInt:unavailable,setNodePropFloat:unavailable,setNodePropNull:unavailable,setNodePropArray:unavailable,setNodePropNodeRef:unavailable,setNodePropObject:unavailable,
};
const notifySetPropertyObservers=()=>{};
export const boundary={registrations,faults,calls,get(node,name){return fields.get(key(node.r,name))},emit(node,name,value){if(!registrations.has(key(node.r,name)))return;observerCallbacks.get(node.r)?.get(stringInterner.internString(name))?.(value)}};
`;
}
