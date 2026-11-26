import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRokuDevWorkspace, cleanAbandonedDevWorkspaces } from "./devWorkspace.mjs";
test("development workspaces retain last-good/current generations and retire only abandoned owned trees", () => {
  const root = mkdtempSync(resolve(tmpdir(), "roku-dev-workspaces-"));
  const owner = (path, pid) => {
    mkdirSync(path);
    writeFileSync(
      resolve(path, "roku-dev-owner.json"),
      JSON.stringify({ schema: "react-native-roku-dev-owner/v1", pid }),
    );
  };
  try {
    owner(resolve(root, "roku-dev-abandoned"), 2147483647);
    owner(resolve(root, "roku-dev-active"), process.pid);
    mkdirSync(resolve(root, "unowned"));
    symlinkSync(resolve(root, "unowned"), resolve(root, "roku-dev-link"));
    const workspace = createRokuDevWorkspace(root);
    assert.deepEqual(workspace.abandoned, ["roku-dev-abandoned"]);
    assert.ok(existsSync(resolve(root, "roku-dev-active")));
    assert.ok(existsSync(resolve(root, "unowned")));
    for (const n of [1, 2, 3, 4]) mkdirSync(workspace.generation(n));
    workspace.publish(3);
    assert.equal(existsSync(workspace.generation(1)), false);
    assert.ok(existsSync(workspace.generation(2)));
    assert.ok(existsSync(workspace.generation(3)));
    assert.ok(existsSync(workspace.generation(4)));
    assert.deepEqual(cleanAbandonedDevWorkspaces(root), []);
    workspace.dispose();
    workspace.dispose();
    assert.equal(existsSync(workspace.directory), false);
    assert.throws(() => workspace.generation(1), /retired/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
