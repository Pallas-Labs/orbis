// Orbis's rat-stack fence (PAL-1543): rat-stack's first five principles as lint. Copied from the
// factory's scripts/lint/oxlint-plugin-factory.mjs (PAL-1542, Pallas-Labs/factory 3653ce4).
//
// - fetch-needs-timeout: a `fetch` or Effect `HttpClient` call waits a bounded time.
// - bounded-concurrency: no `concurrency: "unbounded"` and no `Promise.all` over a computed array.
// - no-shared-pending-cache, no-module-level-mutable-state: ported from rat-stack's
//   `rat-stack-patterns` plugin (scripts/oxlint-plugin-patterns.ts, joelhooks/rat-stack).
// - directive-needs-reason: every lint or Effect diagnostic override names its rule and a `-- reason`.
// - no-flag-read-by-string: code reads a feature flag through its generated accessor in
//   `flags.gen.ts`, never by key through `getBooleanValue` (factory v2 flags, PAL-1852).
// - stylex-tokens: a StyleX style takes colours, lengths, type, radii, shadows, layers and timing
//   from the design tokens, never a raw value (PAL-2190).
//
// A site that the rule cannot see is bounded takes `// oxlint-disable-next-line orbis/<rule> -- <reason>`.
// The rules read syntax only; `scripts/fence.test.mjs` runs real Oxlint on `lint-plugins/orbis/fixtures`.

const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const unwrap = (node) =>
  [
    "ParenthesizedExpression",
    "ChainExpression",
    "TSAsExpression",
    "TSNonNullExpression",
    "TSSatisfiesExpression",
    "TSInstantiationExpression",
    "TSTypeAssertion",
  ].includes(node.type)
    ? unwrap(node.expression)
    : node;

const propertyName = (member) => {
  if (member.type !== "MemberExpression") {
    return null;
  }
  if (!member.computed && member.property.type === "Identifier") {
    return member.property.name;
  }
  return member.property.type === "Literal" &&
    typeof member.property.value === "string"
    ? member.property.value
    : null;
};

const variableOf = (name, scope) => {
  for (let current = scope; current !== null; current = current.upper) {
    const variable = current.set.get(name);
    if (variable !== undefined) {
      return variable;
    }
  }
  return null;
};

const calleeText = (node, sourceCode) =>
  sourceCode.getText(unwrap(node.callee));

// `Effect.gen(function* () {...})`, `Effect.fn("name")(function* () {...})` and the like run at
// construction when their result is a Layer's or a module's value.
const isEffectThunk = (fn, sourceCode) => {
  const call = fn.parent;
  if (call?.type !== "CallExpression") {
    return false;
  }
  const text = calleeText(call, sourceCode);
  return /^Effect\s*\.\s*(?:gen|fnUntraced)$|^Effect\s*\.\s*fn\s*\(/u.test(
    text
  );
};

// --- fetch-needs-timeout ---------------------------------------------------------------------

const httpClientMethods = new Set([
  "del",
  "execute",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
]);
const timeoutCall =
  /\b(?:timeout|timeoutOption|timeoutOrElse|timeoutFail|timeoutTo)\s*\(|AbortSignal\s*\.\s*timeout\s*\(/u;
// A sibling argument that names a timeout: `Effect.timeout(...)`, `readTimeout`, `withTimeout(...)`.
const timeoutName = /timeout/iu;

// The text that gave a binding its value: a declarator's initializer or a parameter's annotation.
const bindingText = (name, scope, sourceCode) => {
  const definition = variableOf(name, scope)?.defs[0];
  if (definition === undefined) {
    return null;
  }
  if (
    definition.type === "Variable" &&
    definition.node.type === "VariableDeclarator"
  ) {
    return sourceCode.getText(definition.node);
  }
  if (definition.type === "Parameter") {
    return sourceCode.getText(definition.name);
  }
  return null;
};

const httpCallKind = (node, context) => {
  const callee = unwrap(node.callee);
  const { sourceCode } = context;
  const scope = sourceCode.getScope(node);
  if (callee.type === "Identifier") {
    return callee.name === "fetch" && variableOf("fetch", scope) === null
      ? "fetch"
      : null;
  }
  const name = propertyName(callee);
  if (name === null) {
    return null;
  }
  const object = unwrap(callee.object);
  if (name === "fetch") {
    return object.type === "Identifier" &&
      ["ctx", "globalThis", "self", "window"].includes(object.name)
      ? "fetch"
      : null;
  }
  if (!httpClientMethods.has(name)) {
    return null;
  }
  if (object.type === "Identifier") {
    if (object.name === "HttpClient") {
      return "http";
    }
    const text = bindingText(object.name, scope, sourceCode);
    return text !== null && /\bHttpClient\b/u.test(text) ? "http" : null;
  }
  return /\bHttpClient\b/u.test(sourceCode.getText(object)) ? "http" : null;
};

// A fetch bounded by an abort signal: `{ signal: AbortSignal.timeout(ms) }`, or a helper that is
// handed one, such as Executor's per-call `ctx.signal`.
const hasSignal = (node, sourceCode) =>
  node.arguments
    .slice(1)
    .some((argument) => /\bsignal\b/u.test(sourceCode.getText(argument)));

// True when an enclosing call passes a timeout beside the call, as in
// `http.execute(request).pipe(Effect.timeout("10 seconds"))`, `giveUpAfter(readTimeout, route)`, or
// `Effect.gen(function* () { ... }).pipe(Effect.timeout(...))` around it. The walk passes through
// `Effect.gen` and `Effect.fn` bodies and stops at any other function.
const enclosedByTimeout = (child, sourceCode) => {
  const current = child.parent;
  if (
    current === null ||
    (functionTypes.has(current.type) && !isEffectThunk(current, sourceCode))
  ) {
    return false;
  }
  const sibling = (argument) =>
    argument !== child && timeoutName.test(sourceCode.getText(argument));
  if (current.type === "CallExpression" && current.arguments.some(sibling)) {
    return true;
  }
  return enclosedByTimeout(current, sourceCode);
};

// True when the client the call reads was built with a timeout, as in
// `HttpClient.transformResponse(Effect.timeout(...))`.
const clientHasTimeout = (node, sourceCode) => {
  const callee = unwrap(node.callee);
  if (callee.type !== "MemberExpression") {
    return false;
  }
  const object = unwrap(callee.object);
  if (timeoutCall.test(sourceCode.getText(object))) {
    return true;
  }
  if (object.type !== "Identifier") {
    return false;
  }
  const text = bindingText(object.name, sourceCode.getScope(node), sourceCode);
  return text !== null && timeoutCall.test(text);
};

const fetchNeedsTimeout = {
  create(context) {
    const { sourceCode } = context;
    return {
      CallExpression(node) {
        const kind = httpCallKind(node, context);
        if (kind === null) {
          return;
        }
        if (
          (kind === "fetch" && hasSignal(node, sourceCode)) ||
          enclosedByTimeout(node, sourceCode) ||
          clientHasTimeout(node, sourceCode)
        ) {
          return;
        }
        context.report({ messageId: kind, node });
      },
    };
  },
  meta: {
    docs: {
      description:
        "Bound every fetch and HttpClient call with a timeout (rat-stack: Timeouts bound waiting).",
    },
    messages: {
      fetch:
        "This fetch can wait forever. Pass `signal: AbortSignal.timeout(ms)`, or pipe the Effect that runs it through `Effect.timeout`.",
      http: "This HttpClient call can wait forever. Pipe it through `Effect.timeout(...)`, or build the client with `HttpClient.transformResponse(Effect.timeout(...))`.",
    },
    type: "problem",
  },
};

// --- bounded-concurrency ---------------------------------------------------------------------

// A literal array or struct names each element at the call, so the code bounds the count.
const isFixedCollection = (argument) => {
  const node = argument === undefined ? undefined : unwrap(argument);
  if (node?.type === "ArrayExpression") {
    return node.elements.every(
      (element) => element !== null && element.type !== "SpreadElement"
    );
  }
  if (node?.type === "ObjectExpression") {
    return node.properties.every((property) => property.type === "Property");
  }
  return false;
};

const boundedConcurrency = {
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        const name = propertyName(callee);
        if (
          callee.type === "MemberExpression" &&
          unwrap(callee.object).type === "Identifier" &&
          unwrap(callee.object).name === "Promise" &&
          (name === "all" || name === "allSettled") &&
          !isFixedCollection(node.arguments[0])
        ) {
          context.report({ messageId: "promiseAll", node });
        }
      },
      Property(node) {
        if (
          node.key.type !== "Identifier" ||
          node.key.name !== "concurrency" ||
          node.value.type !== "Literal" ||
          node.value.value !== "unbounded"
        ) {
          return;
        }
        const options = node.parent;
        const call = options?.parent;
        if (
          call?.type === "CallExpression" &&
          call.arguments.includes(options) &&
          isFixedCollection(call.arguments[0])
        ) {
          return;
        }
        context.report({ messageId: "unbounded", node });
      },
    };
  },
  meta: {
    docs: {
      description:
        "Bound concurrent work (rat-stack: Concurrent work needs an owner and a bound).",
    },
    messages: {
      promiseAll:
        "Promise.all over a computed array starts every element at once. Bound it (a fixed-size pool, or Effect.forEach with a numeric concurrency), or give the line `// oxlint-disable-next-line orbis/bounded-concurrency -- <why the count is small>`.",
      unbounded:
        'concurrency: "unbounded" over a computed collection starts every element at once. Give a number, or give the line `// oxlint-disable-next-line orbis/bounded-concurrency -- <why the count is small>`.',
    },
    type: "problem",
  },
};

// --- no-shared-pending-cache -----------------------------------------------------------------

const effectCacheConstructors = new Set([
  "cached",
  "cachedInvalidateWithTTL",
  "cachedWithTTL",
]);
const cacheModuleConstructors = new Set(["make", "makeWith"]);
const emptyCollections = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

const cacheConstructor = (node) => {
  const callee = unwrap(node.callee);
  const name = propertyName(callee);
  if (name === null) {
    return null;
  }
  const object = unwrap(callee.object);
  if (object.type !== "Identifier") {
    return null;
  }
  if (object.name === "Effect" && effectCacheConstructors.has(name)) {
    return `Effect.${name}`;
  }
  if (object.name === "Cache" && cacheModuleConstructors.has(name)) {
    return `Cache.${name}`;
  }
  return null;
};

const isEffectFnMethod = (fn, sourceCode) => {
  const call = fn.parent;
  return (
    call?.type === "CallExpression" &&
    call.parent?.type === "Property" &&
    call.parent.value === call &&
    /^Effect\s*\.\s*fn(?:Untraced)?\b/u.test(calleeText(call, sourceCode))
  );
};

const isLayerCall = (node, sourceCode) =>
  node.type === "CallExpression" &&
  /^Layer\s*\./u.test(calleeText(node, sourceCode));

// Ported from rat-stack's `isSharedConstruction`: true when the node runs while a module or a Layer
// is built, not inside a request's own function.
const isSharedConstruction = (node, context) => {
  const { sourceCode } = context;
  for (let current = node.parent; current !== null; current = current.parent) {
    if (isLayerCall(current, sourceCode)) {
      return true;
    }
    if (functionTypes.has(current.type)) {
      if (isEffectFnMethod(current, sourceCode)) {
        return false;
      }
      if (!isEffectThunk(current, sourceCode)) {
        const upper = sourceCode.getScope(current).upper?.type;
        if (upper !== "module" && upper !== "global") {
          return false;
        }
      }
    }
  }
  return true;
};

const isModuleLevel = (node) => {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (
      functionTypes.has(current.type) ||
      current.type === "StaticBlock" ||
      current.type === "TSModuleBlock" ||
      current.type === "ClassBody"
    ) {
      return false;
    }
    if (current.type === "Program") {
      return true;
    }
  }
  return false;
};

const isPendingPromise = (init, sourceCode) => {
  const value = unwrap(init);
  if (value.type === "NewExpression") {
    return (
      value.callee.type === "Identifier" && value.callee.name === "Promise"
    );
  }
  if (value.type !== "CallExpression") {
    return false;
  }
  const callee = unwrap(value.callee);
  return (
    /^Promise\s*\.\s*(?:all|allSettled|any|race|resolve|try)$/u.test(
      sourceCode.getText(callee)
    ) ||
    ((callee.type === "ArrowFunctionExpression" ||
      callee.type === "FunctionExpression") &&
      callee.async)
  );
};

const isEmptyCollection = (init) => {
  const value = unwrap(init);
  return (
    value.type === "NewExpression" &&
    value.callee.type === "Identifier" &&
    emptyCollections.has(value.callee.name) &&
    (value.arguments.length === 0 ||
      (value.arguments.length === 1 &&
        value.arguments[0].type === "ArrayExpression" &&
        value.arguments[0].elements.length === 0))
  );
};

const noSharedPendingCache = {
  create(context) {
    const { sourceCode } = context;
    return {
      CallExpression(node) {
        const constructor = cacheConstructor(node);
        if (constructor !== null && isSharedConstruction(node, context)) {
          context.report({
            data: { constructor },
            messageId: "pendingCache",
            node,
          });
        }
      },
      VariableDeclarator(node) {
        if (node.init === null || !isModuleLevel(node)) {
          return;
        }
        if (isEmptyCollection(node.init)) {
          context.report({ messageId: "moduleCollection", node });
        } else if (isPendingPromise(node.init, sourceCode)) {
          context.report({ messageId: "modulePromise", node });
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Keep pending work out of shared caches (rat-stack: Shared caches hold completed values).",
    },
    messages: {
      moduleCollection:
        "A module-level collection that starts empty is a cache every caller in this process shares. Keep it in a Ref inside a Layer, or pass it in; a scoped exception names the value it holds and its lifetime with `-- <reason>`.",
      modulePromise:
        "A module-level Promise shares one pending result with every caller, and a failure stays cached for the process's life. Build it inside the request or the Layer that owns it.",
      pendingCache:
        "{{constructor}} at this scope shares pending work across requests: one caller's interruption or failure reaches every caller waiting on it. Cache completed values, or move the cache into the request; a scoped exception names its lifetime with `-- <reason>`.",
    },
    type: "problem",
  },
};

// --- no-module-level-mutable-state -----------------------------------------------------------

const noModuleLevelMutableState = {
  create(context) {
    return {
      VariableDeclaration(node) {
        if (node.kind !== "let" && node.kind !== "var") {
          return;
        }
        const moduleScoped =
          node.kind === "let"
            ? ["global", "module"].includes(
                context.sourceCode.getScope(node).type
              )
            : isModuleLevel(node);
        if (moduleScoped) {
          context.report({ messageId: "moduleState", node });
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Keep state out of module-level let and var bindings (ported from rat-stack).",
    },
    messages: {
      moduleState:
        "Module-level let and var hold state that outlives one request: every request a Worker isolate or server process handles shares it. Keep the state in a `Ref` inside a Layer, a Durable Object or the database.",
    },
    type: "problem",
  },
};

// --- directive-needs-reason ------------------------------------------------------------------

const lintDirective =
  /^\s*(?<kind>(?:oxlint|eslint)-(?:disable|enable)(?:-next-line|-line)?|@effect-diagnostics(?:-next-line)?)(?<rest>(?:\s[\s\S]*)?)$/u;

// The parts of a directive: the rules before ` -- ` and the reason after it.
export const parseDirective = (text) => {
  const match = lintDirective.exec(text);
  if (match?.groups === undefined) {
    return null;
  }
  const { kind, rest } = match.groups;
  const split = rest.indexOf(" -- ");
  const rules = (split === -1 ? rest : rest.slice(0, split)).trim();
  const reason = split === -1 ? "" : rest.slice(split + 4).trim();
  return { kind, reason, rules };
};

const directiveNeedsReason = {
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const directive = parseDirective(comment.value);
          if (directive === null || directive.kind.includes("-enable")) {
            continue;
          }
          if (directive.rules === "") {
            context.report({ loc: comment.loc, messageId: "noRule" });
          } else if (directive.reason === "") {
            context.report({ loc: comment.loc, messageId: "noReason" });
          }
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Every lint or Effect diagnostic override names its rule and a reason (rat-stack: the fence).",
    },
    messages: {
      noReason:
        "This override gives no reason. End it with ` -- <why the rule does not apply here>`.",
      noRule:
        "This override names no rule, so it silences every rule. Name the rule it turns off, then ` -- <reason>`.",
    },
    type: "problem",
  },
};

// --- no-flag-read-by-string ---------------------------------------------------------------

// `flags.gen.ts` gives each declared flag an accessor, so `flags check` can count its reads and an
// undeclared flag does not compile. A `getBooleanValue("key", ...)` call skips both, so only the
// generated file may call it.
const noFlagReadByString = {
  create(context) {
    if (context.filename.endsWith("flags.gen.ts")) {
      return {};
    }
    return {
      CallExpression(node) {
        if (propertyName(unwrap(node.callee)) === "getBooleanValue") {
          context.report({ messageId: "byString", node });
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Code reads a feature flag through its generated accessor, not by key (factory v2 flags).",
    },
    messages: {
      byString:
        "This reads a flag by key. Read it through its generated accessor in flags.gen.ts.",
    },
    type: "problem",
  },
};

// --- stylex-tokens --------------------------------------------------------------------------

// A StyleX style takes its colours, lengths, type, radii, shadows, layers and timing from the
// design tokens (`tokens.stylex.ts`), so a theme changes every use and a wrong value is a wrong
// name, which TypeScript refuses. A literal of that kind inside `stylex.create` is reported;
// keywords such as `auto`, `100%` and `transparent`, and template literals built on a token, pass.
const tokenKinds = {
  color: new Set([
    "accentColor",
    "backgroundColor",
    "borderBlockColor",
    "borderBottomColor",
    "borderColor",
    "borderInlineColor",
    "borderInlineEndColor",
    "borderInlineStartColor",
    "borderLeftColor",
    "borderRightColor",
    "borderTopColor",
    "caretColor",
    "color",
    "fill",
    "outlineColor",
    "stroke",
    "textDecorationColor",
  ]),
  font: new Set([
    "fontFamily",
    "fontSize",
    "fontWeight",
    "letterSpacing",
    "lineHeight",
  ]),
  layer: new Set(["zIndex"]),
  length: new Set([
    "blockSize",
    "borderBlockEndWidth",
    "borderBlockStartWidth",
    "borderBlockWidth",
    "borderBottomWidth",
    "borderInlineEndWidth",
    "borderInlineStartWidth",
    "borderInlineWidth",
    "borderLeftWidth",
    "borderRightWidth",
    "borderTopWidth",
    "borderWidth",
    "bottom",
    "columnGap",
    "flexBasis",
    "gap",
    "height",
    "inlineSize",
    "inset",
    "insetBlock",
    "insetBlockEnd",
    "insetBlockStart",
    "insetInline",
    "insetInlineEnd",
    "insetInlineStart",
    "left",
    "margin",
    "marginBlock",
    "marginBlockEnd",
    "marginBlockStart",
    "marginBottom",
    "marginInline",
    "marginInlineEnd",
    "marginInlineStart",
    "marginLeft",
    "marginRight",
    "marginTop",
    "maxBlockSize",
    "maxHeight",
    "maxInlineSize",
    "maxWidth",
    "minBlockSize",
    "minHeight",
    "minInlineSize",
    "minWidth",
    "outlineOffset",
    "outlineWidth",
    "padding",
    "paddingBlock",
    "paddingBlockEnd",
    "paddingBlockStart",
    "paddingBottom",
    "paddingInline",
    "paddingInlineEnd",
    "paddingInlineStart",
    "paddingLeft",
    "paddingRight",
    "paddingTop",
    "right",
    "rowGap",
    "top",
    "width",
  ]),
  radius: new Set([
    "borderBottomLeftRadius",
    "borderBottomRightRadius",
    "borderEndEndRadius",
    "borderEndStartRadius",
    "borderRadius",
    "borderStartEndRadius",
    "borderStartStartRadius",
    "borderTopLeftRadius",
    "borderTopRightRadius",
  ]),
  shadow: new Set(["boxShadow"]),
  timing: new Set([
    "animationDelay",
    "animationDuration",
    "animationTimingFunction",
    "transitionDelay",
    "transitionDuration",
    "transitionTimingFunction",
  ]),
};
const kinds = new Map(
  Object.entries(tokenKinds).flatMap(([kind, keys]) =>
    [...keys].map((key) => [key, kind])
  )
);
const kindOf = (key) => kinds.get(key);

// Values no token stands for: keywords, percentages, viewport units, a zero, and a variable that
// Base UI sets at run time. Any other `var()` would let a raw value skip its token.
const keyword =
  /^(?:var\(--(?:anchor-width|available-height|transform-origin)\)|-?0(?:px|s|ms)?|-?\d+(?:\.\d+)?(?:%|vw|vh|svh|dvh|lvh)|auto|none|normal|inherit|initial|unset|revert|transparent|currentcolor|canvas|canvastext|fit-content|min-content|max-content|stretch|ease|linear|ease-in|ease-out|ease-in-out)$/iu;
// A raw colour or rem length inside a template literal that also uses a token.
const rawInTemplate =
  /#[\da-f]{3,8}\b|\b(?:oklch|oklab|rgba?|hsla?|lab|lch|hwb)\(|\d(?:\.\d+)?rem\b/iu;

const isStylexCreate = (node, context) => {
  const callee = unwrap(node.callee);
  // `stylex.create` through any name for the namespace, or `create` imported by name.
  const binding =
    callee.type === "MemberExpression"
      ? propertyName(callee) === "create" &&
        callee.object.type === "Identifier" &&
        callee.object.name
      : callee.type === "Identifier" && callee.name === "create" && callee.name;
  if (!binding) {
    return false;
  }
  const variable = variableOf(binding, context.sourceCode.getScope(node));
  const definition = variable?.defs[0];
  return (
    definition?.type === "ImportBinding" &&
    definition.parent.source.value === "@stylexjs/stylex"
  );
};

const keyName = (property) => {
  if (property.computed) {
    return null;
  }
  if (property.key.type === "Identifier") {
    return property.key.name;
  }
  return property.key.type === "Literal" ? String(property.key.value) : null;
};

const stylexTokens = {
  create(context) {
    const checkValue = (kind, node) => {
      const value = unwrap(node);
      if (value.type === "ObjectExpression") {
        // `{ default: ..., ":hover": ... }` conditions.
        for (const property of value.properties) {
          if (property.type === "Property") {
            checkValue(kind, property.value);
          }
        }
        return;
      }
      if (value.type === "ConditionalExpression") {
        checkValue(kind, value.consequent);
        checkValue(kind, value.alternate);
        return;
      }
      if (value.type === "Literal") {
        if (value.value === null) {
          return;
        }
        const text = String(value.value).trim();
        if (
          (kind === "layer" && /^-?[01]$/u.test(text)) ||
          keyword.test(text)
        ) {
          return;
        }
        context.report({ data: { kind, text }, messageId: "raw", node: value });
        return;
      }
      if (value.type === "TemplateLiteral") {
        const text = value.quasis.map((quasi) => quasi.value.cooked).join("…");
        if (value.expressions.length === 0) {
          if (!keyword.test(text.trim())) {
            context.report({
              data: { kind, text },
              messageId: "raw",
              node: value,
            });
          }
          return;
        }
        if (rawInTemplate.test(text)) {
          context.report({
            data: { kind, text },
            messageId: "raw",
            node: value,
          });
        }
      }
    };
    const checkStyle = (style) => {
      const body = unwrap(style);
      if (functionTypes.has(body.type)) {
        // A dynamic style: `(x) => ({ ... })`.
        checkStyle(body.body);
        return;
      }
      if (body.type !== "ObjectExpression") {
        return;
      }
      for (const property of body.properties) {
        if (property.type !== "Property") {
          continue;
        }
        const key = keyName(property);
        const kind = key === null ? undefined : kindOf(key);
        if (kind !== undefined) {
          checkValue(kind, property.value);
        } else if (key?.startsWith(":") || key?.startsWith("@")) {
          // A legacy nested condition holds a whole style.
          checkStyle(property.value);
        }
      }
    };
    return {
      CallExpression(node) {
        const styles =
          node.arguments[0] === undefined
            ? undefined
            : unwrap(node.arguments[0]);
        if (
          styles?.type !== "ObjectExpression" ||
          !isStylexCreate(node, context)
        ) {
          return;
        }
        for (const namespace of styles.properties) {
          if (namespace.type === "Property") {
            checkStyle(namespace.value);
          }
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "A StyleX style reads colours, lengths, type, radii, shadows, layers and timing from the design tokens.",
    },
    messages: {
      raw: "`{{text}}` is a raw {{kind}} value. Use a token from src/styles/tokens.stylex.ts, or add one there.",
    },
    type: "problem",
  },
};

export default {
  meta: { name: "orbis" },
  rules: {
    "bounded-concurrency": boundedConcurrency,
    "directive-needs-reason": directiveNeedsReason,
    "fetch-needs-timeout": fetchNeedsTimeout,
    "no-flag-read-by-string": noFlagReadByString,
    "no-module-level-mutable-state": noModuleLevelMutableState,
    "no-shared-pending-cache": noSharedPendingCache,
    "stylex-tokens": stylexTokens,
  },
};
