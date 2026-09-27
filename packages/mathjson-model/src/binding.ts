import { isPlainMathJson, type PlainMathJson } from "./index";
import {
  RESERVED_BUILTIN_SYMBOLS,
  operatorDeclarationsSchema,
  type OperatorDeclaration,
} from "./contracts";
import {
  binderShape,
  readBinderDeclaration,
  type BinderDeclaration,
  type BinderShape,
} from "./binders";

export type BindingEnvironment = Readonly<{
  operators?: readonly OperatorDeclaration[];
}>;

export type SymbolSubstitution = Readonly<{
  symbol: string;
  replacement: PlainMathJson;
}>;

export type AlphaRenaming = Readonly<{
  binderPath: readonly number[];
  from: string;
  to: string;
}>;

export type SubstitutionDiagnostic = Readonly<{
  code:
    | "invalid-expression"
    | "invalid-environment"
    | "invalid-substitution"
    | "invalid-binder"
    | "invalid-operator-replacement";
  message: string;
  path: readonly number[];
  symbol?: string;
}>;

export type SubstitutionResult =
  | Readonly<{
      ok: true;
      expression: PlainMathJson;
      alphaRenamings: readonly AlphaRenaming[];
      diagnostics: readonly [];
    }>
  | Readonly<{
      ok: false;
      expression: PlainMathJson;
      alphaRenamings: readonly [];
      diagnostics: readonly SubstitutionDiagnostic[];
    }>;

type ValidatedBindingEnvironment = Readonly<{
  operators: readonly OperatorDeclaration[];
  operatorSymbols: ReadonlySet<string>;
}>;

type FunctionParts = Readonly<{
  operator: string;
  operands: readonly PlainMathJson[];
  rebuild: (operator: string, operands: readonly PlainMathJson[]) => PlainMathJson;
}>;

/** Return lexically free symbol names in deterministic order. */
export function freeSymbolNames(
  expression: PlainMathJson,
  environment: BindingEnvironment = {},
): readonly string[] {
  if (!isPlainMathJson(expression)) return [];
  const validated = parseEnvironment(environment);
  if (validated === undefined) return [];
  return [...collectFreeSymbolNames(expression, validated, new Set())].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

/** Pick a stable name, adding the first available numeric suffix when necessary. */
export function freshSymbolName(
  preferred: string,
  forbidden: ReadonlySet<string> | readonly string[],
): string {
  const used = forbidden instanceof Set ? forbidden : new Set(forbidden);
  const base = preferred.length > 0 ? preferred : "variable";
  if (!used.has(base) && !RESERVED_BUILTIN_SYMBOLS.has(base)) return base;

  let suffix = 1;
  while (used.has(`${base}_${suffix}`) || RESERVED_BUILTIN_SYMBOLS.has(`${base}_${suffix}`)) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
}

/**
 * Apply simultaneous, capture-avoiding substitutions. Replacements are not
 * recursively substituted. Any invalid operation rejects atomically and
 * returns the exact original expression.
 */
export function substituteMathJson(
  expression: PlainMathJson,
  substitutions: readonly SymbolSubstitution[],
  environment: BindingEnvironment = {},
): SubstitutionResult {
  if (!isPlainMathJson(expression)) {
    return failure(expression, {
      code: "invalid-expression",
      message: "Substitution requires serializable plain MathJSON.",
      path: [],
    });
  }

  const validated = parseEnvironment(environment);
  if (validated === undefined) {
    return failure(expression, {
      code: "invalid-environment",
      message: "The binding environment contains invalid or conflicting operators.",
      path: [],
    });
  }

  const inputDiagnostics: SubstitutionDiagnostic[] = [];
  validateBindingStructure(expression, validated, [], inputDiagnostics);
  if (inputDiagnostics.length > 0) return failures(expression, inputDiagnostics);

  const substitutionMap = new Map<string, PlainMathJson>();
  for (const substitution of substitutions) {
    if (
      substitution.symbol.length === 0 ||
      RESERVED_BUILTIN_SYMBOLS.has(substitution.symbol) ||
      validated.operatorSymbols.has(substitution.symbol) ||
      substitutionMap.has(substitution.symbol) ||
      !isPlainMathJson(substitution.replacement)
    ) {
      return failure(expression, {
        code: "invalid-substitution",
        message:
          "Substitution targets must be unique variable symbols with valid plain MathJSON replacements.",
        path: [],
        symbol: substitution.symbol,
      });
    }
    const replacementDiagnostics: SubstitutionDiagnostic[] = [];
    validateBindingStructure(substitution.replacement, validated, [], replacementDiagnostics);
    if (replacementDiagnostics.length > 0) {
      return failures(
        expression,
        replacementDiagnostics.map((diagnostic) => ({
          ...diagnostic,
          message: `Invalid replacement for ${substitution.symbol}: ${diagnostic.message}`,
        })),
      );
    }
    substitutionMap.set(substitution.symbol, substitution.replacement);
  }

  if (substitutionMap.size === 0) {
    return { ok: true, expression, alphaRenamings: [], diagnostics: [] };
  }

  const replacementFreeSymbols = new Map<string, ReadonlySet<string>>();
  substitutionMap.forEach((replacement, symbol) => {
    replacementFreeSymbols.set(symbol, collectFreeSymbolNames(replacement, validated, new Set()));
  });

  const usedNames = collectAllSymbolNames(expression);
  validated.operatorSymbols.forEach((symbol) => usedNames.add(symbol));
  substitutionMap.forEach((replacement, symbol) => {
    usedNames.add(symbol);
    collectAllSymbolNames(replacement).forEach((name) => usedNames.add(name));
  });

  const diagnostics: SubstitutionDiagnostic[] = [];
  const alphaRenamings: AlphaRenaming[] = [];
  const substituted = substituteExpression(
    expression,
    [],
    new Set(),
    substitutionMap,
    replacementFreeSymbols,
    usedNames,
    validated,
    diagnostics,
    alphaRenamings,
  );

  if (diagnostics.length > 0) {
    return {
      ok: false,
      expression,
      alphaRenamings: [],
      diagnostics,
    };
  }
  return {
    ok: true,
    expression: substituted,
    alphaRenamings,
    diagnostics: [],
  };
}

function failure(
  expression: PlainMathJson,
  diagnostic: SubstitutionDiagnostic,
): SubstitutionResult {
  return {
    ok: false,
    expression,
    alphaRenamings: [],
    diagnostics: [diagnostic],
  };
}

function failures(
  expression: PlainMathJson,
  diagnostics: readonly SubstitutionDiagnostic[],
): SubstitutionResult {
  return {
    ok: false,
    expression,
    alphaRenamings: [],
    diagnostics,
  };
}

function parseEnvironment(
  environment: BindingEnvironment,
): ValidatedBindingEnvironment | undefined {
  const parsed = operatorDeclarationsSchema.safeParse(environment.operators ?? []);
  if (!parsed.success) return undefined;
  return {
    operators: parsed.data,
    operatorSymbols: new Set(parsed.data.map((operator) => operator.symbol)),
  };
}

function substituteExpression(
  expression: PlainMathJson,
  path: readonly number[],
  blocked: ReadonlySet<string>,
  substitutions: ReadonlyMap<string, PlainMathJson>,
  replacementFreeSymbols: ReadonlyMap<string, ReadonlySet<string>>,
  usedNames: Set<string>,
  environment: ValidatedBindingEnvironment,
  diagnostics: SubstitutionDiagnostic[],
  alphaRenamings: AlphaRenaming[],
): PlainMathJson {
  const symbol = symbolValue(expression);
  if (symbol !== undefined) {
    const replacement = blocked.has(symbol) ? undefined : substitutions.get(symbol);
    return replacement ?? expression;
  }

  const parts = functionParts(expression);
  if (parts === undefined) return expression;
  const binder = binderFor(parts, environment);
  if (binder === undefined) {
    const operator = substituteOperator(
      parts.operator,
      path,
      blocked,
      substitutions,
      environment,
      diagnostics,
    );
    const operands = parts.operands.map((operand, index) =>
      substituteExpression(
        operand,
        [...path, index],
        blocked,
        substitutions,
        replacementFreeSymbols,
        usedNames,
        environment,
        diagnostics,
        alphaRenamings,
      ),
    );
    return rebuildIfChanged(expression, parts, operator, operands);
  }

  const binding = readBinding(parts, binder, environment, path, diagnostics);
  if (binding === undefined) return expression;

  const renamings = new Map<string, string>();
  for (const boundName of binding.names) {
    const captureRisk = [...substitutions.keys()].some((target) => {
      if (blocked.has(target) || binding.names.has(target)) return false;
      const replacementNames = replacementFreeSymbols.get(target);
      if (replacementNames?.has(boundName) !== true) return false;
      return binding.scopedOperandIndices.some((index) => {
        const operand = parts.operands[index];
        if (operand === undefined) return false;
        const namesBlockedHere = new Set([...blocked, ...binding.names]);
        return collectFreeSymbolNames(operand, environment, namesBlockedHere).has(target);
      });
    });
    if (!captureRisk) continue;
    const fresh = freshSymbolName(boundName, usedNames);
    usedNames.add(fresh);
    renamings.set(boundName, fresh);
    alphaRenamings.push({ binderPath: path, from: boundName, to: fresh });
  }

  const renamedBindingNames = new Set(
    [...binding.names].map((name) => renamings.get(name) ?? name),
  );
  const scopedBlocked = new Set([...blocked, ...renamedBindingNames]);
  const operands = parts.operands.map((operand, index) => {
    const declaration = binding.declarations.get(index);
    if (declaration !== undefined) {
      // A declaration's domain or bounds belong to the enclosing scope.
      return rebuildDeclaration(operand, declaration, renamings.get(declaration.name), (outer, j) =>
        substituteExpression(
          outer,
          [...path, index, j],
          blocked,
          substitutions,
          replacementFreeSymbols,
          usedNames,
          environment,
          diagnostics,
          alphaRenamings,
        ),
      );
    }

    const isScoped = binding.scopedOperandIndexSet.has(index);
    const alphaRenamed =
      isScoped && renamings.size > 0
        ? renameBoundOccurrences(operand, renamings, environment, new Set())
        : operand;
    return substituteExpression(
      alphaRenamed,
      [...path, index],
      isScoped ? scopedBlocked : blocked,
      substitutions,
      replacementFreeSymbols,
      usedNames,
      environment,
      diagnostics,
      alphaRenamings,
    );
  });

  return rebuildIfChanged(expression, parts, parts.operator, operands);
}

function substituteOperator(
  operator: string,
  path: readonly number[],
  blocked: ReadonlySet<string>,
  substitutions: ReadonlyMap<string, PlainMathJson>,
  environment: ValidatedBindingEnvironment,
  diagnostics: SubstitutionDiagnostic[],
): string {
  if (
    blocked.has(operator) ||
    RESERVED_BUILTIN_SYMBOLS.has(operator) ||
    environment.operatorSymbols.has(operator)
  ) {
    return operator;
  }
  const replacement = substitutions.get(operator);
  if (replacement === undefined) return operator;
  // MathJSON stores a function head as a bare string. Accepting an object-form
  // symbol here would silently discard its metadata, so callers must provide a
  // bare non-binding symbol (or model a term-valued head with an explicit Apply).
  if (
    typeof replacement === "string" &&
    binderShape(replacement, 0, environment.operators) === undefined
  ) {
    return replacement;
  }

  diagnostics.push({
    code: "invalid-operator-replacement",
    message:
      "A symbol used in function position can only be replaced by a non-binding symbol without an explicit Apply operator.",
    path,
    symbol: operator,
  });
  return operator;
}

function readBinding(
  parts: FunctionParts,
  binder: BinderShape,
  environment: ValidatedBindingEnvironment,
  path: readonly number[],
  diagnostics: SubstitutionDiagnostic[],
):
  | Readonly<{
      names: ReadonlySet<string>;
      declarations: ReadonlyMap<number, BinderDeclaration>;
      scopedOperandIndices: readonly number[];
      scopedOperandIndexSet: ReadonlySet<number>;
    }>
  | undefined {
  if (!binderArityMatches(parts, environment)) {
    diagnostics.push({
      code: "invalid-binder",
      message: "A binder application must have exactly the operands declared by its signature.",
      path,
      symbol: parts.operator,
    });
    return undefined;
  }

  const names = new Set<string>();
  const declarations = new Map<number, BinderDeclaration>();
  for (const index of binder.boundOperands) {
    const operand = parts.operands[index];
    const declaration =
      operand === undefined ? undefined : readBinderDeclaration(operand, binder.forms);
    const name = declaration?.name ?? (operand === undefined ? undefined : symbolValue(operand));
    if (
      declaration === undefined ||
      names.has(declaration.name) ||
      RESERVED_BUILTIN_SYMBOLS.has(declaration.name) ||
      environment.operatorSymbols.has(declaration.name)
    ) {
      diagnostics.push({
        code: "invalid-binder",
        message:
          "Binder operands must declare distinct non-reserved symbols in a form the binder admits.",
        path: [...path, index],
        ...(name === undefined ? {} : { symbol: name }),
      });
      return undefined;
    }
    names.add(declaration.name);
    declarations.set(index, declaration);
  }

  return {
    names,
    declarations,
    scopedOperandIndices: binder.scopedOperands,
    scopedOperandIndexSet: new Set(binder.scopedOperands),
  };
}

/** Built-in binders have fixed arities, except `Function`, which takes at least one parameter. */
function binderArityMatches(
  parts: FunctionParts,
  environment: ValidatedBindingEnvironment,
): boolean {
  const count = parts.operands.length;
  switch (parts.operator) {
    case "ForAll":
    case "Exists":
    case "Sum":
    case "Product":
    case "Integrate":
      return count === 2;
    case "Function":
      return count >= 2;
    default:
      return (
        environment.operators.find((operator) => operator.symbol === parts.operator)?.signature
          .parameters.length === count
      );
  }
}

function validateBindingStructure(
  expression: PlainMathJson,
  environment: ValidatedBindingEnvironment,
  path: readonly number[],
  diagnostics: SubstitutionDiagnostic[],
): void {
  const parts = functionParts(expression);
  if (parts === undefined) return;
  const binder = binderFor(parts, environment);
  if (binder === undefined) {
    parts.operands.forEach((operand, index) =>
      validateBindingStructure(operand, environment, [...path, index], diagnostics),
    );
    return;
  }

  const binding = readBinding(parts, binder, environment, path, diagnostics);
  if (binding === undefined) return;
  parts.operands.forEach((operand, index) => {
    const declaration = binding.declarations.get(index);
    if (declaration === undefined) {
      validateBindingStructure(operand, environment, [...path, index], diagnostics);
      return;
    }
    const declarationOperands = functionParts(operand)?.operands ?? [];
    declaration.outerOperands.forEach((outerIndex) => {
      const outer = declarationOperands[outerIndex];
      if (outer !== undefined) {
        validateBindingStructure(outer, environment, [...path, index, outerIndex], diagnostics);
      }
    });
  });
}

function renameBoundOccurrences(
  expression: PlainMathJson,
  renamings: ReadonlyMap<string, string>,
  environment: ValidatedBindingEnvironment,
  shadowed: ReadonlySet<string>,
): PlainMathJson {
  const symbol = symbolValue(expression);
  if (symbol !== undefined) {
    const replacement = shadowed.has(symbol) ? undefined : renamings.get(symbol);
    return replacement === undefined ? expression : renameSymbolNode(expression, replacement);
  }

  const parts = functionParts(expression);
  if (parts === undefined) return expression;
  const operator =
    shadowed.has(parts.operator) ||
    RESERVED_BUILTIN_SYMBOLS.has(parts.operator) ||
    environment.operatorSymbols.has(parts.operator)
      ? parts.operator
      : (renamings.get(parts.operator) ?? parts.operator);
  const binder = shadowed.has(parts.operator) ? undefined : binderFor(parts, environment);
  if (binder === undefined) {
    const operands = parts.operands.map((operand) =>
      renameBoundOccurrences(operand, renamings, environment, shadowed),
    );
    return rebuildIfChanged(expression, parts, operator, operands);
  }

  const declarations = readDeclarations(parts, binder);
  const nestedShadowed = new Set([...shadowed, ...[...declarations.values()].map((d) => d.name)]);
  const scopedIndices = new Set(binder.scopedOperands);
  const operands = parts.operands.map((operand, index) => {
    const declaration = declarations.get(index);
    if (declaration !== undefined) {
      return rebuildDeclaration(operand, declaration, undefined, (outer) =>
        renameBoundOccurrences(outer, renamings, environment, shadowed),
      );
    }
    if (binder.boundOperands.includes(index)) return operand;
    return renameBoundOccurrences(
      operand,
      renamings,
      environment,
      scopedIndices.has(index) ? nestedShadowed : shadowed,
    );
  });
  return rebuildIfChanged(expression, parts, operator, operands);
}

function collectFreeSymbolNames(
  expression: PlainMathJson,
  environment: ValidatedBindingEnvironment,
  bound: ReadonlySet<string>,
  result: Set<string> = new Set(),
): Set<string> {
  const symbol = symbolValue(expression);
  if (symbol !== undefined) {
    if (!bound.has(symbol) && !RESERVED_BUILTIN_SYMBOLS.has(symbol)) result.add(symbol);
    return result;
  }

  const parts = functionParts(expression);
  if (parts === undefined) return result;
  if (
    !bound.has(parts.operator) &&
    !RESERVED_BUILTIN_SYMBOLS.has(parts.operator) &&
    !environment.operatorSymbols.has(parts.operator)
  ) {
    result.add(parts.operator);
  }

  const binder = bound.has(parts.operator) ? undefined : binderFor(parts, environment);
  if (binder === undefined) {
    parts.operands.forEach((operand) =>
      collectFreeSymbolNames(operand, environment, bound, result),
    );
    return result;
  }

  const declarations = readDeclarations(parts, binder);
  const nestedBound = new Set(bound);
  declarations.forEach((declaration) => nestedBound.add(declaration.name));
  const scopedIndices = new Set(binder.scopedOperands);
  parts.operands.forEach((operand, index) => {
    const declaration = declarations.get(index);
    if (declaration !== undefined) {
      const declarationOperands = functionParts(operand)?.operands ?? [];
      declaration.outerOperands.forEach((outerIndex) => {
        const outer = declarationOperands[outerIndex];
        if (outer !== undefined) collectFreeSymbolNames(outer, environment, bound, result);
      });
      return;
    }
    if (binder.boundOperands.includes(index)) return;
    collectFreeSymbolNames(
      operand,
      environment,
      scopedIndices.has(index) ? nestedBound : bound,
      result,
    );
  });
  return result;
}

function collectAllSymbolNames(
  expression: PlainMathJson,
  result: Set<string> = new Set(),
): Set<string> {
  const symbol = symbolValue(expression);
  if (symbol !== undefined) {
    result.add(symbol);
    return result;
  }
  const parts = functionParts(expression);
  if (parts === undefined) return result;
  result.add(parts.operator);
  parts.operands.forEach((operand) => collectAllSymbolNames(operand, result));
  return result;
}

function binderFor(
  parts: FunctionParts,
  environment: ValidatedBindingEnvironment,
): BinderShape | undefined {
  return binderShape(parts.operator, parts.operands.length, environment.operators);
}

/** Readable declarations of a binder node by operand index; malformed operands are omitted. */
function readDeclarations(
  parts: FunctionParts,
  binder: BinderShape,
): ReadonlyMap<number, BinderDeclaration> {
  const declarations = new Map<number, BinderDeclaration>();
  binder.boundOperands.forEach((index) => {
    const operand = parts.operands[index];
    const declaration =
      operand === undefined ? undefined : readBinderDeclaration(operand, binder.forms);
    if (declaration !== undefined) declarations.set(index, declaration);
  });
  return declarations;
}

/**
 * Rebuild a bound operand: rename its bound symbol when `renamed` is given and map the domain or
 * bounds of an `Element`/`Limits` declaration. Unchanged operands keep their identity.
 */
function rebuildDeclaration(
  operand: PlainMathJson,
  declaration: BinderDeclaration,
  renamed: string | undefined,
  mapOuter: (outer: PlainMathJson, index: number) => PlainMathJson,
): PlainMathJson {
  if (declaration.form === "symbol") {
    return renamed === undefined ? operand : renameSymbolNode(operand, renamed);
  }
  const parts = functionParts(operand);
  if (parts === undefined) return operand;
  const outerIndices = new Set(declaration.outerOperands);
  const operands = parts.operands.map((item, index) => {
    if (index === 0) return renamed === undefined ? item : renameSymbolNode(item, renamed);
    return outerIndices.has(index) ? mapOuter(item, index) : item;
  });
  return rebuildIfChanged(operand, parts, parts.operator, operands);
}

function symbolValue(expression: PlainMathJson): string | undefined {
  if (typeof expression === "string") return expression;
  if (!isRecord(expression)) return undefined;
  const record = expression as Readonly<Record<string, unknown>>;
  return typeof record.sym === "string" ? record.sym : undefined;
}

function renameSymbolNode(expression: PlainMathJson, symbol: string): PlainMathJson {
  if (typeof expression === "string") return symbol;
  if (!isRecord(expression)) return expression;
  const record = expression as Readonly<Record<string, unknown>>;
  if (typeof record.sym !== "string") return expression;
  return { ...record, sym: symbol } as PlainMathJson;
}

function functionParts(expression: PlainMathJson): FunctionParts | undefined {
  if (Array.isArray(expression)) {
    const operator = expression[0];
    if (typeof operator !== "string") return undefined;
    return {
      operator,
      operands: expression.slice(1) as readonly PlainMathJson[],
      rebuild: (nextOperator, operands) => [nextOperator, ...operands],
    };
  }
  if (!isRecord(expression)) return undefined;
  const record = expression as Readonly<Record<string, unknown>>;
  if (!Array.isArray(record.fn)) return undefined;
  const operator = record.fn[0];
  if (typeof operator !== "string") return undefined;
  return {
    operator,
    operands: record.fn.slice(1) as readonly PlainMathJson[],
    rebuild: (nextOperator, operands) =>
      ({
        ...record,
        fn: [nextOperator, ...operands],
      }) as PlainMathJson,
  };
}

function rebuildIfChanged(
  original: PlainMathJson,
  parts: FunctionParts,
  operator: string,
  operands: readonly PlainMathJson[],
): PlainMathJson {
  const unchanged =
    operator === parts.operator &&
    operands.length === parts.operands.length &&
    operands.every((operand, index) => operand === parts.operands[index]);
  return unchanged ? original : parts.rebuild(operator, operands);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
