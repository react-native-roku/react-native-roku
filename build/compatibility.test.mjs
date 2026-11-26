import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { auditCompatibility } from "./compatibility.mjs";
test("compatibility audit rejects unreviewed imports, unsupported APIs, members and explicit JSX props", () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-import-contract-"));
  try {
    writeFileSync(
      resolve(root, "App.tsx"),
      `import {View,StyleSheet,Switch,type ViewStyle} from 'react-native'; import * as RN from 'react-native';import {thing} from 'new-library';const {Text}=require('react-native');StyleSheet.unknown();RN['Missing']();export const App=()=> <View inventedProp={1} {...thing}><Text>Hi</Text></View>;`,
    );
    const result = auditCompatibility({ root, files: ["App.tsx"] });
    assert.equal(result.status, "failed");
    for (const text of [
      "Switch is unsupported",
      "Unreviewed library new-library",
      "StyleSheet.unknown",
      "Missing",
      "prop inventedProp",
    ])
      assert.ok(
        result.violations.some((value) => value.message.includes(text)),
        text,
      );
    assert.ok(result.dynamic.some((value) => value.kind === "spread-props"));
    assert.ok(!result.violations.some((value) => value.message.includes("ViewStyle")));
    writeFileSync(
      resolve(root, "App.tsx"),
      `import {View,Text,StyleSheet} from 'react-native';StyleSheet.create({});export const App=()=> <View><Text>Hi</Text></View>;`,
    );
    assert.equal(auditCompatibility({ root, files: ["App.tsx"] }).status, "passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("namespace imports do not bypass reviewed third-party API names", () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-namespace-contract-"));
  try {
    writeFileSync(
      resolve(root, "App.ts"),
      "import * as Library from 'reviewed';Library.accepted();Library.unreviewed();Library['computed']();",
    );
    const result = auditCompatibility({
      root,
      files: ["App.ts"],
      libraries: { reviewed: { version: "1.0.0", imports: ["*", "accepted"] } },
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(result.violations.map((value) => value.message).sort(), [
      "Unreviewed library API reviewed.computed",
      "Unreviewed library API reviewed.unreviewed",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
