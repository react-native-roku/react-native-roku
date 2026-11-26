/** React's public entry wrappers choose one implementation per frontend profile.
 * Metro development keeps conditional requires, so select this reviewed wrapper
 * before dependency collection. Keep source positions and immutable input bytes. */
exports.prepareReactEntry = function prepareReactEntry(source, filename, development) {
  const entry =
    /(?:^|[/\\])node_modules[/\\]react[/\\](index|jsx-runtime|jsx-dev-runtime|compiler-runtime)\.js$/.exec(
      filename,
    )?.[1];
  if (!entry) return source;
  const base = entry === "index" ? "react" : "react-" + entry;
  const match =
    /^(?<prefix>[\s\S]*?)\bif\s*\(\s*process\.env\.NODE_ENV\s*===\s*(?<envQuote>['"])production\k<envQuote>\s*\)\s*\{\s*(?<production>module\.exports\s*=\s*require\(\s*(?<pq>['"])(?<productionPath>[^'"]+)\k<pq>\s*\)\s*;)\s*\}\s*else\s*\{\s*(?<development>module\.exports\s*=\s*require\(\s*(?<dq>['"])(?<developmentPath>[^'"]+)\k<dq>\s*\)\s*;)\s*\}\s*$/d.exec(
      source,
    );
  const prefix = match?.groups.prefix;
  const header = prefix
    ?.replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\r\n]*/g, "")
    .trim();
  if (
    !match ||
    !["'use strict';", '"use strict";'].includes(header) ||
    match.groups.productionPath !== `./cjs/${base}.production.js` ||
    match.groups.developmentPath !== `./cjs/${base}.development.js`
  )
    throw Error(`Review the pinned React entry before selecting its profile: ${filename}`);
  const [start, end] = match.indices.groups[development ? "development" : "production"];
  const blank = (value) => value.replace(/[^\r\n]/g, " ");
  return (
    prefix +
    blank(source.slice(prefix.length, start)) +
    source.slice(start, end) +
    blank(source.slice(end))
  );
};
