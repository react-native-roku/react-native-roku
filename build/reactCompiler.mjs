import { fileURLToPath } from "node:url";
import { nativeTextMemo } from "./nativeTextMemo.mjs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, relative, resolve, sep, isAbsolute } from "node:path";

export async function usesReactJsxRuntime(configuration) {
  const { jsx, jsxImportSource, tsconfig, tsconfigRaw, absWorkingDir } = configuration;
  if (
    jsx !== "automatic" ||
    (jsxImportSource && jsxImportSource !== "react") ||
    !tsconfig ||
    tsconfigRaw
  )
    return false;
  const { default: ts } = await import("typescript");
  const project = ts.getParsedCommandLineOfConfigFile(
    resolve(absWorkingDir ?? process.cwd(), tsconfig),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic() {},
    },
  );
  return (
    !!project &&
    !project.errors.length &&
    (!project.options.jsxImportSource || project.options.jsxImportSource === "react")
  );
}

/** Compile the consumer's React sources before esbuild lowers JSX. */
export function appReactCompiler(root, generated, memoText = false) {
  const require = createRequire(resolve(root, "package.json"));
  let babel, compiler;
  try {
    babel = require("@babel/core");
    compiler = require("babel-plugin-react-compiler");
  } catch (cause) {
    throw new Error("Install @babel/core and babel-plugin-react-compiler in the Roku consumer", {
      cause,
    });
  }
  const inside = (base, file) => {
    const path = relative(base, file);
    return !isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep);
  };
  return {
    name: "roku-app-react-compiler",
    async setup(builder) {
      const reuseText = memoText && (await usesReactJsxRuntime(builder.initialOptions));
      if (reuseText) {
        builder.onResolve({ filter: /^roku-compiler:pressable$/ }, () => ({
          path: fileURLToPath(new URL("../src/react-native/compilerPressable.ts", import.meta.url)),
        }));
      }
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: "file" }, async ({ path }) => {
        if (
          !inside(root, path) ||
          inside(generated, path) ||
          relative(root, path).split(sep).includes("node_modules")
        )
          return;
        const extension = extname(path);
        const ts = /[.]([cm]?ts|tsx)$/.test(extension);
        const jsx = extension === ".jsx" || extension === ".tsx";
        let compiled = false;
        const source = await readFile(path, "utf8");
        const parseOptions = {
          filename: path,
          configFile: false,
          babelrc: false,
          sourceMaps: "inline",
          parserOpts: { plugins: [...(jsx ? ["jsx"] : []), ...(ts ? ["typescript"] : [])] },
        };
        let result = await babel.transformAsync(source, {
          ...parseOptions,
          plugins: [
            [
              compiler,
              {
                target: "19",
                logger: {
                  logEvent(_file, event) {
                    if (event.kind === "CompileSuccess") compiled = true;
                  },
                },
              },
            ],
          ],
        });
        if (reuseText && jsx) {
          let changed = false;
          const memo = await babel.transformAsync(compiled ? result.code : source, {
            ...parseOptions,
            plugins: [
              (babel) =>
                nativeTextMemo(babel, () => {
                  changed = true;
                }),
            ],
          });
          if (changed) {
            result = memo;
            compiled = true;
          }
        }
        if (compiled)
          return { contents: result.code, loader: ts ? (jsx ? "tsx" : "ts") : jsx ? "jsx" : "js" };
      });
    },
  };
}
