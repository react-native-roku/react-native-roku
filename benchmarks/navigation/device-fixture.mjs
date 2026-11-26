import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRokuDeviceClient, parseActiveApp, parseMediaPlayer } from "../../build/device.mjs";

export async function fixture(zip, receiptPath, host, { timeoutMs = 3000 } = {}) {
  const artifact = readFileSync(zip);
  const receipt = readFileSync(receiptPath, "utf8");
  const match =
    /Currently Installed Application:\s*([\da-f]{32})\s+zip file[^\r\n(]*\(([\d,]+) bytes\)/i.exec(
      receipt,
    );
  const digest = (hash) => createHash(hash).update(artifact).digest("hex");
  assert.equal(match?.[1].toLowerCase(), digest("md5"), "Installer checksum mismatch");
  assert.equal(
    Number(match[2].replaceAll(",", "")),
    artifact.length,
    "Installer byte count mismatch",
  );
  const client = createRokuDeviceClient({ host, timeoutMs });
  assert.equal(parseActiveApp(await client.query("active-app")).id, "dev");
  assert.ok(["close", "none"].includes(parseMediaPlayer(await client.query("media-player")).state));
  return { client, sha256: digest("sha256") };
}
