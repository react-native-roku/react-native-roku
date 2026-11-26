const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const { resolveAdapter } = require("./index.mjs");
const { resolveRokuRelative } = require("./resolution.mjs");
const { nativewindLeaf } = require("./nativewind.mjs");
exports.withRokuBabelTransformer = require("./metroTransformer.cjs").withRokuBabelTransformer;
/** Target-scoped Metro resolver integration. SDK packaging/HMR is a separate stage. */
exports.withRoku = function withRoku(config, { root = config.projectRoot ?? process.cwd() } = {}) {
  const nativeRequire = createRequire(resolve(root, "package.json"));
  const previous = config.resolver?.resolveRequest;
  return {
    ...config,
    resolver: {
      ...config.resolver,
      platforms: [...new Set([...(config.resolver?.platforms ?? []), "roku"])],
      resolveRequest(context, name, platform) {
        if (platform === "roku") {
          const adapter = resolveAdapter(name);
          if (adapter) return { type: "sourceFile", filePath: adapter };
          if (name === "react" || name.startsWith("react/"))
            return {
              type: "sourceFile",
              filePath: nativeRequire.resolve(name),
            };
          if (name.startsWith("react-native/") || name.startsWith("@roku-sdk/"))
            throw Error(`Unadapted native import in Roku frontend: ${name}`);
          const leaf = nativewindLeaf(name, context.originModulePath, nativeRequire);
          if (leaf) return { type: "sourceFile", filePath: leaf };
          const selected = resolveRokuRelative(context.originModulePath, name);
          if (selected) return { type: "sourceFile", filePath: selected };
        }
        return previous
          ? previous(context, name, platform)
          : context.resolveRequest(context, name, platform);
      },
    },
  };
};
