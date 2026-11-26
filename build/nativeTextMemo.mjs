// A literal style object created inside this JSX expression has no application
// owner. Sharing the element is safe when its input is primitive, it has no
// attached ref, and both the text and every style value still agree.
export function nativeTextMemo(babel, selected) {
  const { types: t, template } = babel;
  const helpers = [];
  const emitted = new WeakSet();
  const scalarChildren = new WeakSet();
  const scalarProps = new Set([
    "nativeID",
    "testID",
    "disabled",
    "focusable",
    "accessible",
    "accessibilityRole",
    "accessibilityLabel",
    "pointerEvents",
    "importantForAccessibility",
    "accessibilityElementsHidden",
  ]);
  const admitted = new Set([
    "key",
    "ref",
    "style",
    "children",
    "onFocus",
    "onFocusCapture",
    "onBlur",
    "onBlurCapture",
    "onPress",
    "onPressIn",
    "onPressOut",
    "onLongPress",
    "delayLongPress",
    "hasTVPreferredFocus",
    ...scalarProps,
  ]);
  const nonWhitespace = (child) =>
    !t.isJSXText(child) || child.value.trim() || !/[\r\n]/.test(child.value);
  let markStyle, markElement;

  const optsOut = (node) => node.directives?.some(({ value }) => value.value === "use no memo");
  const fromNative = (path, name, names) => {
    if (!t.isJSXIdentifier(name)) return false;
    const binding = path.scope.getBinding(name.name)?.path;
    return Boolean(
      binding?.isImportSpecifier() &&
      names.includes(binding.node.imported.name) &&
      binding.parent.source.value === "react-native",
    );
  };

  const retainPressableStyle = (path, program) => {
    const element = path.node.openingElement;
    if (
      !fromNative(path, element.name, ["Pressable"]) ||
      !element.attributes.every(
        (attr) =>
          t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name) && admitted.has(attr.name.name),
      )
    )
      return false;
    const attribute = element.attributes.find(
      (attribute) => t.isJSXAttribute(attribute) && attribute.name.name === "style",
    );
    if (!t.isJSXExpressionContainer(attribute?.value)) return false;
    const callback = attribute.value.expression;
    if (!t.isArrowFunctionExpression(callback) || callback.async) return false;
    const returned = t.isBlockStatement(callback.body) ? callback.body.body.at(-1) : undefined;
    const literal = t.isReturnStatement(returned) ? returned.argument : callback.body;
    if (!t.isObjectExpression(literal)) return false;
    const properties = literal.properties;
    if (
      properties.length < 2 ||
      properties.length > 12 ||
      properties.some(
        (property) =>
          !t.isObjectProperty(property) ||
          property.computed ||
          (!t.isIdentifier(property.key) && !t.isStringLiteral(property.key)) ||
          (property.key.name ?? property.key.value) === "__proto__",
      )
    )
      return false;
    if (
      optsOut(program.path.node) ||
      path.findParent((ancestor) => ancestor.isFunction() && optsOut(ancestor.node.body)) ||
      program.hasBinding("Map", { noGlobals: true }) ||
      program.hasBinding("Object", { noGlobals: true })
    )
      return false;

    const candidates = properties.filter(({ value }) => !t.isLiteral(value));
    if (candidates.length < 2) return false;
    const keys = candidates.slice(0, 2).map((property) => properties.indexOf(property));
    markStyle ??= program.generateUidIdentifier("markPressableStyle");
    markElement ??= program.generateUidIdentifier("markPressableElement");
    const helper = program.generateUidIdentifier("renderPressableStyle");
    const storage = program.generateUidIdentifier("pressableStyles");
    const size = program.generateUidIdentifier("pressableStyleCount");
    const styles = properties.map(() => program.generateUidIdentifier("style"));
    const [keyA, keyB] = keys.map((key) => styles[key].name);
    const object = t.objectExpression(
      properties.map(({ key }, index) =>
        t.objectProperty(t.cloneNode(key), t.cloneNode(styles[index])),
      ),
    );
    const same = styles
      .map(({ name }, index) => `Object.is(previous[${index + 1}], ${name})`)
      .join(" && ");
    const cacheable = styles
      .map(
        ({ name }) =>
          `(${name} === null || typeof ${name} === "undefined" || typeof ${name} === "number" || typeof ${name} === "boolean" || (typeof ${name} === "string" && ${name}.length <= 256))`,
      )
      .join(" && ");
    const declaration = template.statement(`
function ${helper.name}() {
  const cache = ${storage.name} ??= new Map();
  let bucket = cache.get(${keyA});
  const previous = bucket?.get(${keyB});
  if (previous && ${same}) return previous[0];
  const style = %%OBJECT%%;
  if ((previous || ${size.name} < 64) && (${cacheable})) {
    if (!bucket) cache.set(${keyA}, bucket = new Map());
    if (!previous) ${size.name}++;
    bucket.set(${keyB}, [${markStyle.name}(style), ${styles.map(({ name }) => name).join(", ")}]);
  }
  return style;
}
`)({ OBJECT: object });
    declaration.params = styles;
    helpers.push(
      t.variableDeclaration("var", [
        t.variableDeclarator(storage),
        t.variableDeclarator(size, t.numericLiteral(0)),
      ]),
      declaration,
    );
    const cached = t.callExpression(
      helper,
      properties.map(({ value }) => value),
    );
    if (t.isReturnStatement(returned)) returned.argument = cached;
    else callback.body = cached;
    selected();
    return true;
  };
  return {
    visitor: {
      JSXElement: {
        enter(path, state) {
          if (state.hasCustomJsxRuntime) return;
          if (!path.getFunctionParent() || emitted.has(path.node)) return;
          const program = path.scope.getProgramParent();
          const node = path.node;
          const { name, attributes } = node.openingElement;
          if (!fromNative(path, name, ["Text"]) || attributes.length !== 1) return;
          const parent = path.parentPath;
          if (
            !parent.isJSXElement() ||
            !fromNative(parent, parent.node.openingElement.name, ["View", "Pressable"])
          )
            return;

          const attr = attributes[0];
          if (
            !t.isJSXAttribute(attr) ||
            attr.name.name !== "style" ||
            !t.isJSXExpressionContainer(attr.value) ||
            !t.isObjectExpression(attr.value.expression)
          )
            return;
          const style = attr.value.expression.properties;
          if (
            !style.length ||
            style.length > 12 ||
            style.some(
              (item) =>
                !t.isObjectProperty(item) ||
                item.computed ||
                (!t.isIdentifier(item.key) && !t.isStringLiteral(item.key)) ||
                (item.key.name ?? item.key.value) === "__proto__",
            )
          )
            return;
          const children = node.children.filter(nonWhitespace);
          if (
            children.length !== 1 ||
            !t.isJSXExpressionContainer(children[0]) ||
            t.isJSXEmptyExpression(children[0].expression)
          )
            return;

          if (
            optsOut(program.path.node) ||
            path.findParent((ancestor) => ancestor.isFunction() && optsOut(ancestor.node.body)) ||
            program.hasBinding("Map", { noGlobals: true }) ||
            program.hasBinding("Object", { noGlobals: true })
          )
            return;
          const helper = program.generateUidIdentifier("renderNativeText");
          const storage = program.generateUidIdentifier("nativeTextCache");
          const cache = program.generateUidIdentifier("cache");
          const previous = program.generateUidIdentifier("previous");
          const result = program.generateUidIdentifier("element");
          const styles = style.map(() => program.generateUidIdentifier("style"));
          const content = program.generateUidIdentifier("content");
          const element = t.cloneNode(node);
          element.openingElement.attributes[0].value.expression.properties = style.map(
            (item, index) => t.objectProperty(t.cloneNode(item.key), t.cloneNode(styles[index])),
          );
          element.children = [t.jsxExpressionContainer(t.cloneNode(content))];
          const sameValues = styles
            .map(
              (parameter, index) => `Object.is(${previous.name}[${index + 2}], ${parameter.name})`,
            )
            .join(" && ");
          const primitiveStyles = styles
            .map(
              ({ name }) =>
                `(${name} === null || typeof ${name} === "undefined" || (typeof ${name} === "string" && ${name}.length <= 256) || typeof ${name} === "number" || typeof ${name} === "boolean")`,
            )
            .join(" && ");
          const declaration = template.statement(`
function ${helper.name}() {
  const ${cache.name} = ${storage.name} ??= new Map();
  const ${previous.name} = ${cache.name}.get(${content.name});
  if (${previous.name} && Object.is(${previous.name}[1], ${content.name}) && ${sameValues})
    return ${previous.name}[0];
  const ${result.name} = %%ELEMENT%%;
  if ((typeof ${content.name} === "number" || (typeof ${content.name} === "string" && ${content.name}.length <= 512))
      && ${primitiveStyles} && (${previous.name} || ${cache.name}.size < 32))
    ${cache.name}.set(${content.name}, [${[result, content, ...styles].map(({ name }) => name).join(", ")}]);
  return ${result.name};
}
`)({ ELEMENT: element });
          declaration.params = [...styles, content];
          emitted.add(element);
          helpers.push(t.variableDeclaration("var", [t.variableDeclarator(storage)]), declaration);
          const scalar = t.jsxExpressionContainer(
            t.callExpression(helper, [...style.map((item) => item.value), children[0].expression]),
          );
          scalarChildren.add(scalar);
          path.replaceWith(scalar);
          path.skip();
          selected();
        },
        exit(path, state) {
          if (state.hasCustomJsxRuntime || emitted.has(path.node) || !path.getFunctionParent())
            return;
          const contents = path.node.children.filter(nonWhitespace);
          if (contents.length !== 1 || !scalarChildren.has(contents[0])) return;
          const program = path.scope.getProgramParent();
          if (!retainPressableStyle(path, program)) return;
          const rawKeys = path.node.openingElement.attributes
            .map(({ name }) => name.name)
            .filter((name) => scalarProps.has(name));
          const keys = program.generateUidIdentifier("pressableKeys");
          helpers.push(t.variableDeclaration("var", [t.variableDeclarator(keys)]));
          const storedKeys = t.assignmentExpression(
            "??=",
            keys,
            t.arrayExpression(rawKeys.map((name) => t.stringLiteral(name))),
          );
          const needsContainer = path.listKey === "children" || path.parentPath.isJSXAttribute();
          const node = t.cloneNode(path.node);
          emitted.add(node);
          const call = t.callExpression(markElement, [node, storedKeys]);
          path.replaceWith(needsContainer ? t.jsxExpressionContainer(call) : call);
          path.skip();
        },
      },
      Program: {
        enter(_path, state) {
          state.hasCustomJsxRuntime = /@jsx(?:ImportSource|Runtime|Frag)?\b/.test(state.file.code);
        },
        exit(path) {
          if (markStyle) {
            path.unshiftContainer(
              "body",
              t.importDeclaration(
                [
                  t.importSpecifier(markStyle, t.identifier("markPressableStyle")),
                  t.importSpecifier(markElement, t.identifier("markPressableElement")),
                ],
                t.stringLiteral("roku-compiler:pressable"),
              ),
            );
          }
          if (helpers.length) path.pushContainer("body", helpers);
        },
      },
    },
  };
}
