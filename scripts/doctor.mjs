import { doctorEnvironment } from "../build/environment.mjs";
const result = doctorEnvironment();
console.log(JSON.stringify(result, null, 2));
if (result.status !== "passed") process.exitCode = 1;
