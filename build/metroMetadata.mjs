import { existsSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/** Observe the public serializer hooks without changing module selection/IDs. */
export function createMetroMetadata(root, serializer, refresh) {
  if (
    typeof serializer?.createModuleIdFactory !== "function" ||
    typeof serializer.processModuleFilter !== "function"
  )
    throw Error("Review the Metro serializer metadata boundary");
  const ids = new Map(),
    records = new Map();
  const name = (path) => relative(root, path).split(sep).join("/");
  const result = {
    serializer: {
      ...serializer,
      createModuleIdFactory() {
        const assign = serializer.createModuleIdFactory.call(serializer);
        return (path) => {
          const id = assign(path);
          if (ids.has(id) && ids.get(id) !== path)
            throw Error("Metro assigned one module ID to different source files");
          ids.set(id, path);
          return id;
        };
      },
      processModuleFilter(module) {
        const accepted = serializer.processModuleFilter.call(serializer, module);
        if (accepted) {
          const physical = isAbsolute(module.path) && existsSync(module.path);
          const source = physical ? module.getSource() : null;
          records.set(module.path, {
            physical,
            embeddedSource: source?.includes("data:image/") ? source.toString("utf8") : null,
            refreshSource: refresh && source ? source.toString("utf8") : null,
            input: physical
              ? {
                  bytes: Buffer.byteLength(source),
                  imports: [...module.dependencies.values()].map((dependency) => ({
                    path: dependency.absolutePath
                      ? name(dependency.absolutePath)
                      : dependency.data.name,
                    kind: dependency.data.data.asyncType
                      ? "dynamic-import"
                      : dependency.data.data.isESMImport
                        ? "import-statement"
                        : "require-call",
                    original: dependency.data.name,
                    ...(!dependency.absolutePath ? { external: true } : {}),
                  })),
                }
              : null,
            scripts: module.output
              .filter((output) => output.type === "js/script")
              .map((output) => output.data.code),
          });
        }
        return accepted;
      },
    },
    moduleInput(id, bytes) {
      const path = ids.get(id),
        record = records.get(path);
      if (!record) throw Error(`Unattested Metro module ID: ${id}`);
      return record.physical ? { path: name(path), bytesInOutput: bytes } : null;
    },
    moduleRefresh(id) {
      const path = ids.get(id),
        record = records.get(path);
      if (!record) throw Error(`Unattested Metro refresh module: ${id}`);
      return { source: name(path), safe: refresh.session.classify(path, record.refreshSource) };
    },
    scriptInputs(preamble) {
      const inputs = {},
        occupied = [];
      for (const [path, record] of records) {
        if (!record.physical) continue;
        for (const raw of record.scripts) {
          const code = raw.trimEnd();
          if (!code) continue;
          let offset = preamble.indexOf(code);
          while (
            offset !== -1 &&
            occupied.some(([start, end]) => offset < end && offset + code.length > start)
          )
            offset = preamble.indexOf(code, offset + 1);
          if (offset === -1) throw Error(`Unattested Metro startup script: ${path}`);
          occupied.push([offset, offset + code.length]);
          const key = name(path);
          inputs[key] = {
            bytesInOutput: (inputs[key]?.bytesInOutput ?? 0) + Buffer.byteLength(code),
          };
        }
      }
      return inputs;
    },
    metafile(outputs) {
      const used = new Set(Object.values(outputs).flatMap((output) => Object.keys(output.inputs)));
      return {
        inputs: Object.fromEntries(
          [...records]
            .filter(([path, record]) => record.physical && used.has(name(path)))
            .map(([path, record]) => [name(path), record.input]),
        ),
        outputs,
      };
    },
    outputName: name,
    embeddedSources(inputs) {
      return [...records]
        .filter(
          ([path, record]) =>
            record.embeddedSource && (!inputs || Object.hasOwn(inputs, name(path))),
        )
        .map(([path, record]) => ({ path, source: record.embeddedSource }));
    },
  };
  return result;
}
