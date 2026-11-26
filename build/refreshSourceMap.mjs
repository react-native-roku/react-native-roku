import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { GenMapping, addMapping, setSourceContent, toEncodedMap } from "@jridgewell/gen-mapping";
import { TraceMap, eachMapping } from "@jridgewell/trace-mapping";

export function refreshSourceMaps(graph) {
  if (!graph.sourceMap) return null;
  const bytes = readFileSync(graph.sourceMap.path);
  if (createHash("sha256").update(bytes).digest("hex") !== graph.sourceMap.sha256)
    throw Error("The Metro refresh source map changed before publication");
  const trace = new TraceMap(JSON.parse(bytes), graph.sourceMap.url);
  const mappings = [];
  eachMapping(trace, (mapping) => mappings.push(mapping));
  return (file, parts) => {
    const result = new GenMapping({ file }),
      used = new Set();
    for (const part of parts) {
      const { startLine, startColumn, endLine, endColumn } = part.module.span;
      for (const mapping of mappings) {
        const line = mapping.generatedLine - 1,
          column = mapping.generatedColumn;
        if (
          line < startLine ||
          line > endLine ||
          (line === startLine && column < startColumn) ||
          (line === endLine && column >= endColumn)
        )
          continue;
        const offset = line - startLine;
        const generated = {
          line: part.line + offset,
          column: column - (offset === 0 ? startColumn : 0),
        };
        if (mapping.source === null) addMapping(result, { generated });
        else {
          used.add(mapping.source);
          addMapping(result, {
            generated,
            original: { line: mapping.originalLine, column: mapping.originalColumn },
            source: mapping.source,
            ...(mapping.name === null ? {} : { name: mapping.name }),
          });
        }
      }
    }
    for (const source of used) {
      const index = trace.resolvedSources.indexOf(source);
      if (trace.sourcesContent?.[index] != null)
        setSourceContent(result, source, trace.sourcesContent[index]);
    }
    return JSON.stringify(toEncodedMap(result));
  };
}
