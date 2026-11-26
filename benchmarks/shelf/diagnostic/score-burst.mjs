import { readFileSync } from "node:fs";
import { scoreBurst } from "../burst.mjs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const trials = report.trials.map(({ events, edges, ...trial }) => {
  const down = edges.filter((edge) => edge.phase === "down");
  const up = edges.filter((edge) => edge.phase === "up");
  const overlapMs = down
    .slice(1)
    .map((edge, index) => (up[index] ? up[index].deviceMs - edge.deviceMs : null));
  const actualEdges = edges.map((edge) => edge.key + ":" + edge.phase);
  const callbackFocus = report.fixture === "react" ? trial.reactFocus : trial.sdkFocus;
  const score = scoreBurst({ ...trial, callbackFocus, edges: actualEdges });
  return { ...trial, ...score, edges, overlapMs };
});
const pass = trials.length > 0 && !report.missingTrials && trials.every((trial) => trial.pass);
console.log(JSON.stringify({ pass, missingTrials: report.missingTrials, trials }, null, 2));
if (!pass) process.exitCode = 1;
