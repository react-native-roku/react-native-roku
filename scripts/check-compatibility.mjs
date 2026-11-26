import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { packageRoot } from "../build/index.mjs";
import { compatibility, discoverAdapterSurface } from "../build/compatibility.mjs";
const discovered = discoverAdapterSurface(packageRoot);
const write = process.argv.includes("--write");
for (const [name, module] of Object.entries(compatibility.modules)) {
  const old = module.exports;
  if (write)
    module.exports = Object.fromEntries(
      Object.entries(discovered[name]).map(([name, surface]) => [
        name,
        {
          ...surface,
          status: old[name]?.status ?? "review-required",
          ...(old[name]?.limitations ? { limitations: old[name].limitations } : {}),
        },
      ]),
    );
  else {
    assert.deepEqual(
      Object.keys(old),
      Object.keys(discovered[name]),
      `Review the ${name} exported API inventory`,
    );
    for (const [apiName, surface] of Object.entries(discovered[name])) {
      assert.deepEqual(
        {
          members: old[apiName].members,
          props: old[apiName].props,
          openProps: old[apiName].openProps,
        },
        surface,
        `Review changed ${module.adapter}.${apiName} properties/members`,
      );
      assert.ok(
        ["partial", "supported", "unsupported"].includes(old[apiName].status),
        `${apiName} needs review`,
      );
    }
  }
  assert.equal(
    module.device,
    "pending",
    "Device qualification requires a separate attested device record",
  );
  assert.ok(module.limitations && module.contracts.length);
  for (const id of module.contracts) {
    assert.ok(compatibility.contracts[id], `Missing contract ${id}`);
    for (const path of compatibility.contracts[id].tests)
      assert.ok(existsSync(resolve(packageRoot, path)), path);
  }
}
if (write)
  writeFileSync(
    resolve(packageRoot, "compatibility/registry.json"),
    JSON.stringify(compatibility, null, 2) + "\n",
  );
else
  console.log(
    JSON.stringify({
      status: "passed",
      modules: Object.keys(discovered).length,
      apis: Object.values(discovered).reduce((sum, value) => sum + Object.keys(value).length, 0),
      deviceQualified: false,
    }),
  );
