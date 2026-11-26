import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("qualification storage enforces budgets, preserves failed inputs and round-trips archived evidence", () => {
  const result = spawnSync(
    "python3",
    [fileURLToPath(new URL("../scripts/test_qualification_storage.py", import.meta.url))],
    {
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.error?.stack ?? result.stdout + result.stderr);
});

test("storage bootstrap rejects invalid budgets before delegation, including nested sessions", () => {
  const entry = new URL("../scripts/qualificationStorage.mjs", import.meta.url).href;
  const program = `const {ensureQualificationStorage}=await import(${JSON.stringify(entry)}); await ensureQualificationStorage({projectRoot:process.cwd()}); console.log("UNEXPECTED_EXECUTION");`;
  for (const budget of ["0", "13", "-1", "1.5", ""]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      encoding: "utf8",
      env: { ...process.env, RNR_QUALIFICATION_RUN_LIMIT_GIB: budget },
      timeout: 10000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RNR_QUALIFICATION_RUN_LIMIT_GIB must be an integer from 1 to 12/);
    assert.ok(!result.stdout.includes("UNEXPECTED_EXECUTION"));
  }
});
