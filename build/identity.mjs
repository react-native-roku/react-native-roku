/** Only public build hashes may cross the diagnostic boundary. */
export function normalizeRokuBuildIdentity(value) {
  if (!value || !/^[A-Za-z][A-Za-z0-9_]*$/.test(value.application ?? ""))
    throw Error("A build identity requires an application identifier");
  const identity = { schema: "react-native-roku-build/v1", application: value.application };
  for (const name of ["inputFingerprint", "runtimeSha256", "frontendGraphSha256"])
    if (value[name] !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(value[name])) throw Error(`Invalid build identity ${name}`);
      identity[name] = value[name];
    }
  return identity;
}

export function isRokuDiagnosticError(line) {
  return /(?:ROKU|RNR)_(?:HOST|RENDER)_ERROR|BRIGHTSCRIPT:\s*ERROR|\b(?:Syntax\s*Error|TypeError|ReferenceError)[:.]|runtime error|Micro Debugger/i.test(
    line,
  );
}
export function parseRokuHostDiagnostics(lines) {
  const identities = [],
    ready = [],
    memory = [],
    errors = [];
  for (const line of lines) {
    if (isRokuDiagnosticError(line)) errors.push(line);
    for (const [marker, target] of [
      ["RNR_BUILD", identities],
      ["RNR_HOST_READY", ready],
      ["RNR_HOST_MEMORY", memory],
    ]) {
      const index = line.indexOf(marker + " ");
      if (index < 0) continue;
      try {
        const value = JSON.parse(line.slice(index + marker.length).trim());
        if (marker === "RNR_BUILD") {
          if (value.schema !== "react-native-roku-build/v1") continue;
          target.push(normalizeRokuBuildIdentity(value));
        } else if (value && typeof value === "object" && !Array.isArray(value)) target.push(value);
      } catch {
        /* Truncated or malformed output is never identity evidence. */
      }
    }
  }
  return { identities, ready, memory, errors };
}
