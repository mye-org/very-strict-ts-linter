import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { collectEstreeChildNodes } from "../lib/estree-children.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds =
  | "noMatchTrue"
  | "preferTypeWildcard"
  | "preferWholeObjectMatch"
  | "noNestedMatch"
  | "preferPatternOverWhen"
  | "preferMultiPatternWith"
  | "preferSelectOverDeepDestructure"
  | "preferOtherwiseOverCatchAll"
  | "preferTernaryOverBooleanMatch";

// eslint-disable-next-line strict-fp/no-domain-raw-primitives -- ESLint rule schema requires boolean options
type RuleOptions = [Partial<Readonly<{ preferOtherwiseOverCatchAll: boolean; preferTernaryOverBooleanMatch: boolean }>>];

type StepKind =
  | { readonly kind: "with"; readonly call: TSESTree.CallExpression }
  | { readonly kind: "when"; readonly call: TSESTree.CallExpression }
  | { readonly kind: "otherwise"; readonly call: TSESTree.CallExpression }
  | { readonly kind: "exhaustive"; readonly call: TSESTree.CallExpression }
  | { readonly kind: "other"; readonly call: TSESTree.CallExpression };

type MatchChain = {
  readonly matchCall: TSESTree.CallExpression;
  readonly inputArg: TSESTree.CallExpressionArgument;
  readonly steps: ReadonlyArray<StepKind>;
};

type ReportFn = (target: TSESTree.Node) => (messageId: MessageIds, data?: Readonly<Record<string, string>>) => void;

type CheckEnv = Readonly<{
  sourceCode: Readonly<TSESLint.SourceCode>;
  visitorKeys: TSESLint.SourceCode["visitorKeys"];
  catchAllMode: "flag" | "skip";
  booleanMatchMode: "flag" | "skip";
  report: ReportFn;
}>;

type ChainContext = Readonly<{ chain: MatchChain; env: CheckEnv }>;
type StepPair = readonly [StepKind, StepKind];

const MATCH_CHAIN_METHODS: ReadonlySet<string> = new Set([
  "with",
  "when",
  "exhaustive",
  "otherwise",
  "run",
  "narrow",
  "returnType",
]);
const STRING_PREDICATE_METHODS: ReadonlySet<string> = new Set(["startsWith", "endsWith", "includes"]);
const NUMBER_PREDICATE_METHODS: ReadonlySet<string> = new Set(["isInteger", "isFinite"]);
const COMPARISON_OPS: ReadonlySet<string> = new Set([">", ">=", "<", "<="]);
const INEQUALITY_OPS: ReadonlySet<string> = new Set(["!==", "!="]);
const EQUALITY_OPS: ReadonlySet<string> = new Set(["===", "==", "!==", "!="]);
const PATTERN_NAMESPACE_NAMES: ReadonlySet<string> = new Set(["P", "Pattern"]);
const WILDCARD_PROP_NAMES: ReadonlySet<string> = new Set(["_", "any"]);
const MATCH_IDENTIFIERS: ReadonlySet<string> = new Set(["match"]);
const ARRAY_IDENTIFIERS: ReadonlySet<string> = new Set(["Array"]);
const NUMBER_IDENTIFIERS: ReadonlySet<string> = new Set(["Number"]);
const IS_ARRAY_METHODS: ReadonlySet<string> = new Set(["isArray"]);
const TEST_METHODS: ReadonlySet<string> = new Set(["test"]);
const SELECT_METHODS: ReadonlySet<string> = new Set(["select"]);
const UNDEFINED_IDENTIFIERS: ReadonlySet<string> = new Set(["undefined"]);
const INTEGER_METHODS: ReadonlySet<string> = new Set(["isInteger"]);
const DOUBLE_EQ_OPS: ReadonlySet<string> = new Set(["=="]);
const DOUBLE_NEQ_OPS: ReadonlySet<string> = new Set(["!="]);
const NULL_RAW_LITERALS: ReadonlySet<string> = new Set(["null"]);
const FUNCTION_TYPES: ReadonlySet<AST_NODE_TYPES> = new Set([
  AST_NODE_TYPES.ArrowFunctionExpression,
  AST_NODE_TYPES.FunctionExpression,
]);

const STEP_KIND_BUILDERS: ReadonlyMap<string, (call: TSESTree.CallExpression) => StepKind> = new Map<
  string,
  (call: TSESTree.CallExpression) => StepKind
>([
  ["with", (call) => ({ kind: "with", call })],
  ["when", (call) => ({ kind: "when", call })],
  ["otherwise", (call) => ({ kind: "otherwise", call })],
  ["exhaustive", (call) => ({ kind: "exhaustive", call })],
]);

const buildOtherStep = (call: TSESTree.CallExpression) => ({ kind: "other", call }) satisfies StepKind;

const toStepKind = (method: string, call: TSESTree.CallExpression) =>
  (STEP_KIND_BUILDERS.get(method) ?? buildOtherStep)(call);

const callArgs = (call: TSESTree.CallExpression) => call.arguments;
const stepArgs = (step: StepKind) => callArgs(step.call);
const stepArgAt = (step: StepKind, idx: number) => O.fromNullable(stepArgs(step)[idx]);
const isComputedMember = (member: TSESTree.MemberExpression) => member.computed;
const isIdentifierNode = (node: TSESTree.Node): node is TSESTree.Identifier =>
  node.type === AST_NODE_TYPES.Identifier;

const isMatchRootCall = (node: TSESTree.CallExpression) =>
  isIdentifierNode(node.callee) && MATCH_IDENTIFIERS.has(node.callee.name) && node.arguments.length === 1;

const isCalleeCall =
  (member: TSESTree.MemberExpression) =>
  (parent: TSESTree.Node): parent is TSESTree.CallExpression =>
    parent.type === AST_NODE_TYPES.CallExpression && parent.callee === member;

const isParentCallOfMember = (member: TSESTree.MemberExpression) =>
  O.fromPredicate(isCalleeCall(member))(member.parent);

const pairMethodWithCall = (method: string) => (call: TSESTree.CallExpression) => [method, call] as const;

const resolveMemberCallParent = (member: TSESTree.MemberExpression, child: TSESTree.Node) =>
  member.object === child && !isComputedMember(member) && isIdentifierNode(member.property)
    ? O.map(pairMethodWithCall(member.property.name))(isParentCallOfMember(member))
    : O.none;

const extractChainedCall = (current: TSESTree.Node) =>
  current.parent?.type === AST_NODE_TYPES.MemberExpression
    ? resolveMemberCallParent(current.parent, current)
    : O.none;

const appendChainStep = ([method, call]: readonly [string, TSESTree.CallExpression]) => [
  toStepKind(method, call),
  ...collectChainSteps(call),
];

const collectChainSteps: (current: TSESTree.Node) => ReadonlyArray<StepKind> = flow(
  extractChainedCall,
  O.match(() => [] satisfies ReadonlyArray<StepKind>, appendChainStep),
);

const memberPropertyNode = (member: TSESTree.MemberExpression) => member.property;

const isIdentifierInSet = (node: TSESTree.Node, set: ReadonlySet<string>) =>
  isIdentifierNode(node) && set.has(node.name);

const isOtherChainMethod = (call: TSESTree.CallExpression) =>
  call.callee.type === AST_NODE_TYPES.MemberExpression &&
  isIdentifierInSet(memberPropertyNode(call.callee), MATCH_CHAIN_METHODS);

const isMatchChainStep = (step: StepKind) => step.kind !== "other" || isOtherChainMethod(step.call);

const firstCallArg = (c: TSESTree.CallExpression) => O.fromNullable(c.arguments[0]);

const collectValidChainSteps = flow(collectChainSteps, O.fromPredicate(RA.some(isMatchChainStep)));

const buildChainFromCall = flow(
  (call: TSESTree.CallExpression) => O.some(call),
  O.bindTo("matchCall"),
  O.bind("inputArg", ({ matchCall }) => firstCallArg(matchCall)),
  O.bind("steps", ({ matchCall }) => collectValidChainSteps(matchCall)),
);

const buildMatchChain = flow(O.fromPredicate(isMatchRootCall), O.flatMap(buildChainFromCall));

const checkNoMatchTrue = (inputArg: TSESTree.CallExpressionArgument, report: ReportFn) => {
  match(inputArg)
    .with({ type: AST_NODE_TYPES.Literal, value: P.boolean }, (lit) => {
      report(lit)("noMatchTrue");
    })
    .with(P._, () => {})
    .exhaustive();
};

const checkTypeofInput = (inputArg: TSESTree.CallExpressionArgument, report: ReportFn) => {
  match(inputArg)
    .with({ type: AST_NODE_TYPES.UnaryExpression, operator: "typeof" }, (expr) => {
      report(expr)("preferTypeWildcard", { suggestion: "P.string / P.number / P.boolean" });
    })
    .with(P._, () => {})
    .exhaustive();
};

const collectPropertyNames = (prop: TSESTree.RestElement | TSESTree.Property) =>
  prop.type === AST_NODE_TYPES.Property
    ? [...collectBoundPatternNames(prop.value)]
    : [...collectBoundPatternNames(prop.argument)];

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive pattern walk
const collectBoundPatternNames = (pattern: TSESTree.Node): ReadonlySet<string> =>
  match(pattern)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => new Set([id.name]))
    .with({ type: AST_NODE_TYPES.ObjectPattern }, (obj) => new Set(RA.flatMap(collectPropertyNames)(obj.properties)))
    .with(
      { type: AST_NODE_TYPES.ArrayPattern },
      (arr) =>
        new Set(
          RA.flatMap((p: TSESTree.DestructuringPattern) => [...collectBoundPatternNames(p)])(
            RA.filterMap(O.fromNullable)(arr.elements),
          ),
        ),
    )
    .with({ type: AST_NODE_TYPES.AssignmentPattern }, (a) => collectBoundPatternNames(a.left))
    .with({ type: AST_NODE_TYPES.RestElement }, (r) => collectBoundPatternNames(r.argument))
    .with(P._, () => new Set<string>())
    .exhaustive();

const isPropertyKeyId = (id: TSESTree.Identifier) =>
  id.parent.type === AST_NODE_TYPES.Property && !id.parent.computed && id.parent.key === id;

const isMemberPropertyId = (id: TSESTree.Identifier) =>
  id.parent.type === AST_NODE_TYPES.MemberExpression && !isComputedMember(id.parent) && id.parent.property === id;

type RefSearchContext = readonly [string, TSESLint.SourceCode["visitorKeys"]];

const hasAnyChildReference = (node: TSESTree.Node, [targetName, visitorKeys]: RefSearchContext) =>
  RA.some((child: TSESTree.Node) => hasIdentifierReference(child, [targetName, visitorKeys]))(
    collectEstreeChildNodes(node, visitorKeys),
  );

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const hasIdentifierReference = (node: TSESTree.Node, [targetName, visitorKeys]: RefSearchContext): boolean =>
  match(node)
    .with(
      { type: AST_NODE_TYPES.Identifier },
      (id) => id.name === targetName && !isPropertyKeyId(id) && !isMemberPropertyId(id),
    )
    .with(P._, (n) => hasAnyChildReference(n, [targetName, visitorKeys]))
    .exhaustive();

const isFunctionNode = (
  node: TSESTree.Node,
): node is TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression => FUNCTION_TYPES.has(node.type);

const isCallbackReferencing = (callback: TSESTree.CallExpressionArgument, [targetName, visitorKeys]: RefSearchContext) =>
  isFunctionNode(callback) &&
  !RA.some(flow(collectBoundPatternNames, (names) => names.has(targetName)))(callback.params) &&
  hasIdentifierReference(callback.body, [targetName, visitorKeys]);

const lastStepArg = flow(stepArgs, RA.last);

const extractStepCallback = (step: StepKind) =>
  match(step)
    .with({ kind: "with" }, lastStepArg)
    .with({ kind: "when" }, (s) => stepArgAt(s, 1))
    .with({ kind: "otherwise" }, (s) => stepArgAt(s, 0))
    .with(P._, () => O.none)
    .exhaustive();

const isStepReferencing = (ctx: RefSearchContext) =>
  flow(
    extractStepCallback,
    O.filter((cb: TSESTree.CallExpressionArgument) => isCallbackReferencing(cb, ctx)),
    O.isSome,
  );

const hasAnyCallbackReferencing = (steps: ReadonlyArray<StepKind>, ctx: RefSearchContext) =>
  RA.some(isStepReferencing(ctx))(steps);

const reportIfWholeObjectNeeded =
  ({ chain, env }: ChainContext) =>
  (objectName: string, propName: string) => {
    match(hasAnyCallbackReferencing(chain.steps, [objectName, env.visitorKeys]))
      .with(true, () => {
        env.report(chain.inputArg)("preferWholeObjectMatch", { objectName, propName });
      })
      .with(false, () => {})
      .exhaustive();
  };

const extractMemberInputNames = (inputArg: TSESTree.CallExpressionArgument) =>
  match(inputArg)
    .with(
      {
        type: AST_NODE_TYPES.MemberExpression,
        computed: false,
        object: { type: AST_NODE_TYPES.Identifier, name: P.select("objectName") },
        property: { type: AST_NODE_TYPES.Identifier, name: P.select("propName") },
      },
      ({ objectName, propName }) => O.some([objectName, propName] as const),
    )
    .with(P._, () => O.none)
    .exhaustive();

const checkWholeObjectMatch = (ctx: ChainContext) => {
  O.match(
    () => {},
    ([objectName, propName]: readonly [string, string]) => {
      reportIfWholeObjectNeeded(ctx)(objectName, propName);
    },
  )(extractMemberInputNames(ctx.chain.inputArg));
};

const extractBlockReturnExpr = flow(
  (block: TSESTree.BlockStatement) => block.body,
  O.fromPredicate((stmts: ReadonlyArray<TSESTree.Statement>) => stmts.length === 1),
  O.flatMap(RA.head),
  O.filter((stmt): stmt is TSESTree.ReturnStatement => stmt.type === AST_NODE_TYPES.ReturnStatement),
  O.flatMap((ret) => O.fromNullable(ret.argument)),
);

const unwrapSingleReturnExpr = (fn: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression) =>
  fn.body.type === AST_NODE_TYPES.BlockStatement ? extractBlockReturnExpr(fn.body) : O.some(fn.body);

const isSameIdentifier = (node: TSESTree.Node, name: string) => isIdentifierNode(node) && node.name === name;

const isNullLiteral = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.Literal && NULL_RAW_LITERALS.has(node.raw);

const isNullOrUndefinedNode = (node: TSESTree.Node) =>
  isNullLiteral(node) || (isIdentifierNode(node) && UNDEFINED_IDENTIFIERS.has(node.name));

const formatTypeofPattern = (typeName: string) => `P.${typeName}`;

const matchTypeofComparison = (expr: TSESTree.BinaryExpression, paramName: string) =>
  EQUALITY_OPS.has(expr.operator) &&
  expr.left.type === AST_NODE_TYPES.UnaryExpression &&
  expr.left.operator === "typeof" &&
  isSameIdentifier(expr.left.argument, paramName) &&
  expr.right.type === AST_NODE_TYPES.Literal &&
  typeof expr.right.value === "string"
    ? O.some(formatTypeofPattern(expr.right.value))
    : O.none;

const matchNullishLogical = (expr: TSESTree.LogicalExpression, paramName: string) =>
  expr.left.type === AST_NODE_TYPES.BinaryExpression &&
  expr.right.type === AST_NODE_TYPES.BinaryExpression &&
  isSameIdentifier(expr.left.left, paramName) &&
  isSameIdentifier(expr.right.left, paramName) &&
  isNullOrUndefinedNode(expr.left.right) &&
  isNullOrUndefinedNode(expr.right.right)
    ? O.some(expr.operator === "||" ? "P.nullish" : "P.nonNullable")
    : O.none;

const matchNullComparison = (op: string) =>
  match(DOUBLE_EQ_OPS.has(op))
    .with(true, () => "P.nullish")
    .with(false, () => (DOUBLE_NEQ_OPS.has(op) ? "P.nonNullable" : "P.nullish / P.nonNullable"))
    .exhaustive();

const matchBinaryTypeWildcard = (bin: TSESTree.BinaryExpression, paramName: string) =>
  match(bin.operator === "instanceof")
    .with(true, () => (isSameIdentifier(bin.left, paramName) ? O.some("P.instanceOf(...)") : O.none))
    .with(false, () =>
      isSameIdentifier(bin.left, paramName) && isNullLiteral(bin.right)
        ? O.some(matchNullComparison(bin.operator))
        : matchTypeofComparison(bin, paramName),
    )
    .exhaustive();

const isArrayIsArrayCallee = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  !callee.computed &&
  isIdentifierNode(callee.object) &&
  ARRAY_IDENTIFIERS.has(callee.object.name) &&
  isIdentifierNode(callee.property) &&
  IS_ARRAY_METHODS.has(callee.property.name);

const matchTypeWildcardExpr = (expr: TSESTree.Expression, paramName: string) =>
  match(expr)
    .with({ type: AST_NODE_TYPES.BinaryExpression }, (bin) => matchBinaryTypeWildcard(bin, paramName))
    .with({ type: AST_NODE_TYPES.LogicalExpression }, (log) => matchNullishLogical(log, paramName))
    .with({ type: AST_NODE_TYPES.CallExpression }, (call) =>
      isArrayIsArrayCallee(call.callee) &&
      O.exists((a: TSESTree.CallExpressionArgument) => isSameIdentifier(a, paramName))(RA.head(call.arguments))
        ? O.some("P.array(P._)")
        : O.none,
    )
    .with(P._, () => O.none)
    .exhaustive();

const isLiteralOrUnaryNumber = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.Literal ||
  (node.type === AST_NODE_TYPES.UnaryExpression &&
    node.operator === "-" &&
    node.argument.type === AST_NODE_TYPES.Literal &&
    typeof node.argument.value === "number");

const formatStringPredicateSuggestion = (methodName: string) => `P.string.${methodName}(...)`;

const formatNumberPredicateSuggestion = (methodName: string) =>
  INTEGER_METHODS.has(methodName) ? "P.number.int()" : "P.number.finite()";

type MemberCallTarget = Readonly<{
  obj: TSESTree.Expression;
  prop: TSESTree.Identifier;
}>;

const isFirstArgName = (args: ReadonlyArray<TSESTree.CallExpressionArgument>, paramName: string) =>
  O.exists((a: TSESTree.CallExpressionArgument) => isSameIdentifier(a, paramName))(RA.head(args));

const isNumberPredicateTarget = ({ obj, prop }: MemberCallTarget) =>
  isIdentifierNode(obj) && NUMBER_IDENTIFIERS.has(obj.name) && NUMBER_PREDICATE_METHODS.has(prop.name);

const classifyNonStringMemberCall =
  (paramName: string) =>
  (args: ReadonlyArray<TSESTree.CallExpressionArgument>) =>
  (target: MemberCallTarget) =>
    match(isNumberPredicateTarget(target) && isFirstArgName(args, paramName))
      .with(true, () => O.some(formatNumberPredicateSuggestion(target.prop.name)))
      .with(false, () =>
        TEST_METHODS.has(target.prop.name) && isFirstArgName(args, paramName)
          ? O.some("P.string.regex(...)")
          : O.none,
      )
      .exhaustive();

const classifyCalleeMember =
  (paramName: string) =>
  (args: ReadonlyArray<TSESTree.CallExpressionArgument>) =>
  (target: MemberCallTarget) =>
    match(isSameIdentifier(target.obj, paramName) && STRING_PREDICATE_METHODS.has(target.prop.name))
      .with(true, () => O.some(formatStringPredicateSuggestion(target.prop.name)))
      .with(false, () => classifyNonStringMemberCall(paramName)(args)(target))
      .exhaustive();

const matchStringOrNumberCall = (call: TSESTree.CallExpression, paramName: string) =>
  call.callee.type === AST_NODE_TYPES.MemberExpression &&
  !call.callee.computed &&
  isIdentifierNode(call.callee.property)
    ? classifyCalleeMember(paramName)(call.arguments)({
        obj: call.callee.object,
        prop: call.callee.property,
      })
    : O.none;

const classifyBinaryWhenOp = (operator: string) =>
  match(INEQUALITY_OPS.has(operator))
    .with(true, () => O.some("P.not(...)"))
    .with(false, () => (COMPARISON_OPS.has(operator) ? O.some("P.number.gt/gte/lt/lte(...)") : O.none))
    .exhaustive();

const matchBinaryPatternOverWhen = (bin: TSESTree.BinaryExpression, paramName: string) =>
  match(isSameIdentifier(bin.left, paramName) && isLiteralOrUnaryNumber(bin.right))
    .with(false, () => O.none)
    .with(true, () => classifyBinaryWhenOp(bin.operator))
    .exhaustive();

const matchRangePattern = (log: TSESTree.LogicalExpression, paramName: string) =>
  log.left.type === AST_NODE_TYPES.BinaryExpression &&
  log.right.type === AST_NODE_TYPES.BinaryExpression &&
  isSameIdentifier(log.left.left, paramName) &&
  isSameIdentifier(log.right.left, paramName) &&
  COMPARISON_OPS.has(log.left.operator) &&
  COMPARISON_OPS.has(log.right.operator)
    ? O.some("P.number.between(...)")
    : O.none;

const matchPatternOverWhenExpr = (expr: TSESTree.Expression, paramName: string) =>
  match(expr)
    .with({ type: AST_NODE_TYPES.BinaryExpression }, (bin) => matchBinaryPatternOverWhen(bin, paramName))
    .with({ type: AST_NODE_TYPES.LogicalExpression, operator: "&&" }, (log) => matchRangePattern(log, paramName))
    .with({ type: AST_NODE_TYPES.CallExpression }, (call) => matchStringOrNumberCall(call, paramName))
    .with(P._, () => O.none)
    .exhaustive();

const extractFnFirstIdentifier = flow(
  (fn: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression) => fn.params,
  RA.head,
  O.filter(isIdentifierNode),
);

const extractFnFirstParamPair = flow(
  (fn: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression) => O.some(fn),
  O.bindTo("fn"),
  O.bind("id", ({ fn }) => extractFnFirstIdentifier(fn)),
  O.bind("expr", ({ fn }) => unwrapSingleReturnExpr(fn)),
  O.map(({ id, expr }) => [id.name, expr] as const),
);

const extractSingleParamPredicate = (arg: TSESTree.CallExpressionArgument) =>
  isFunctionNode(arg) && arg.params.length === 1 ? extractFnFirstParamPair(arg) : O.none;

const extractPredicateArg = (step: StepKind) =>
  match(step)
    .with({ kind: "when" }, (s) => (stepArgs(s).length >= 2 ? stepArgAt(s, 0) : O.none))
    .with({ kind: "with" }, (s) => (stepArgs(s).length === 3 ? O.filter(isFunctionNode)(stepArgAt(s, 1)) : O.none))
    .with(P._, () => O.none)
    .exhaustive();

const reportWhenPatternFallback =
  (report: ReportFn, predNode: TSESTree.Node) =>
  (paramName: string, expr: TSESTree.Expression) => {
    O.match(
      () => {},
      (suggestion: string) => {
        report(predNode)("preferPatternOverWhen", { suggestion });
      },
    )(matchPatternOverWhenExpr(expr, paramName));
  };

const reportPredicateSuggestion =
  (report: ReportFn, predNode: TSESTree.Node) =>
  (paramName: string, expr: TSESTree.Expression) => {
    O.match(
      () => {
        reportWhenPatternFallback(report, predNode)(paramName, expr);
      },
      (suggestion: string) => {
        report(predNode)("preferTypeWildcard", { suggestion });
      },
    )(matchTypeWildcardExpr(expr, paramName));
  };

const resolvePredTuple = flow(
  (predNode: TSESTree.CallExpressionArgument) => O.some(predNode),
  O.bindTo("predNode"),
  O.bind("pair", ({ predNode }) => extractSingleParamPredicate(predNode)),
  O.map(({ predNode, pair: [paramName, expr] }) => [predNode, paramName, expr] as const),
);

const checkPredicateStep = (report: ReportFn) =>
  flow(
    extractPredicateArg,
    O.flatMap(resolvePredTuple),
    O.match(
      () => {},
      ([predNode, paramName, expr]) => {
        reportPredicateSuggestion(report, predNode)(paramName, expr);
      },
    ),
  );

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive chain root lookup
const isMatchChainExpression = (node: TSESTree.Expression): boolean =>
  node.type === AST_NODE_TYPES.CallExpression &&
  (isMatchRootCall(node) ||
    (node.callee.type === AST_NODE_TYPES.MemberExpression && isMatchChainExpression(node.callee.object)));

const checkNestedMatch = (report: ReportFn) =>
  flow(
    extractStepCallback,
    O.filter(isFunctionNode),
    O.flatMap(unwrapSingleReturnExpr),
    O.filter(isMatchChainExpression),
    O.match(
      () => {},
      (nestedExpr) => {
        report(nestedExpr)("noNestedMatch");
      },
    ),
  );

const isSelectMemberCall = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.CallExpression &&
  node.callee.type === AST_NODE_TYPES.MemberExpression &&
  !node.callee.computed &&
  isIdentifierInSet(memberPropertyNode(node.callee), SELECT_METHODS);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const hasPSelectDescendant = (node: TSESTree.Node, visitorKeys: TSESLint.SourceCode["visitorKeys"]): boolean =>
  isSelectMemberCall(node) ||
  RA.some((child: TSESTree.Node) => hasPSelectDescendant(child, visitorKeys))(
    collectEstreeChildNodes(node, visitorKeys),
  );

const isPlainTwoArgWith = (step: StepKind, visitorKeys: TSESLint.SourceCode["visitorKeys"]) =>
  step.kind === "with" &&
  stepArgs(step).length === 2 &&
  O.exists((p: TSESTree.CallExpressionArgument) => !hasPSelectDescendant(p, visitorKeys))(stepArgAt(step, 0));

const adjacentStepPairs = (steps: ReadonlyArray<StepKind>) =>
  RA.filterMapWithIndex((idx: number, step: StepKind) =>
    O.map((next: StepKind) => [step, next] as const)(RA.lookup(idx + 1)(steps)),
  )(steps);

const pairHandlersOption = flow(
  ([prev, curr]: StepPair) => O.some([prev, curr] as const),
  O.bindTo("pair"),
  O.bind("prevH", ({ pair: [prev] }) => stepArgAt(prev, 1)),
  O.bind("currH", ({ pair: [, curr] }) => stepArgAt(curr, 1)),
);

const isAdjacentDuplicatePair = (pair: StepPair, env: CheckEnv) =>
  isPlainTwoArgWith(pair[0], env.visitorKeys) &&
  isPlainTwoArgWith(pair[1], env.visitorKeys) &&
  O.exists(({ prevH, currH }: { readonly prevH: TSESTree.CallExpressionArgument; readonly currH: TSESTree.CallExpressionArgument }) =>
    env.sourceCode.getText(prevH) === env.sourceCode.getText(currH),
  )(pairHandlersOption(pair));

const checkAdjacentPairDuplicate = (pair: StepPair, env: CheckEnv) => {
  match(isAdjacentDuplicatePair(pair, env))
    .with(true, () => {
      env.report(pair[1].call)("preferMultiPatternWith");
    })
    .with(false, () => {})
    .exhaustive();
};

const checkConsecutiveDuplicates = (steps: ReadonlyArray<StepKind>, env: CheckEnv) => {
  RA.map((pair: StepPair) => {
    checkAdjacentPairDuplicate(pair, env);
    return O.none;
  })(adjacentStepPairs(steps));
};

const patternPropertyDepth = (prop: TSESTree.RestElement | TSESTree.Property) =>
  prop.type === AST_NODE_TYPES.Property && prop.value.type === AST_NODE_TYPES.ObjectPattern
    ? 1 + computeObjectPatternDepth(prop.value)
    : 1;

const maxPropertyDepth = flow(
  RA.map(patternPropertyDepth),
  RA.reduce(0, (acc, d) => Math.max(acc, d)),
);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive depth calculation
const computeObjectPatternDepth = (pattern: TSESTree.ObjectPattern): number =>
  maxPropertyDepth(pattern.properties);

const extractFirstCallbackParam = flow(
  (step: StepKind) => stepArgAt(step, 1),
  O.filter(isFunctionNode),
  O.flatMap((fn) => RA.head(fn.params)),
);

const checkDeepDestructure = (env: CheckEnv) =>
  flow(
    O.fromPredicate((s: StepKind) => isPlainTwoArgWith(s, env.visitorKeys)),
    O.flatMap(extractFirstCallbackParam),
    O.filter((p): p is TSESTree.ObjectPattern => p.type === AST_NODE_TYPES.ObjectPattern),
    O.filter((p) => computeObjectPatternDepth(p) >= 2 && collectBoundPatternNames(p).size === 1),
    O.match(
      () => {},
      (param) => {
        env.report(param)("preferSelectOverDeepDestructure");
      },
    ),
  );

const isWildcardPattern = (arg: TSESTree.CallExpressionArgument) =>
  arg.type === AST_NODE_TYPES.MemberExpression &&
  !arg.computed &&
  isIdentifierNode(arg.object) &&
  PATTERN_NAMESPACE_NAMES.has(arg.object.name) &&
  isIdentifierNode(arg.property) &&
  WILDCARD_PROP_NAMES.has(arg.property.name);

const isCatchAllBeforeExhaustive = ([prev, curr]: StepPair) =>
  prev.kind === "with" &&
  stepArgs(prev).length === 2 &&
  O.exists(isWildcardPattern)(stepArgAt(prev, 0)) &&
  curr.kind === "exhaustive";

const checkCatchAllExhaustive = (steps: ReadonlyArray<StepKind>, report: ReportFn) => {
  RA.map((pair: StepPair) => {
    match(isCatchAllBeforeExhaustive(pair))
      .with(true, () => {
        report(pair[0].call)("preferOtherwiseOverCatchAll");
      })
      .with(false, () => {})
      .exhaustive();
    return O.none;
  })(adjacentStepPairs(steps));
};

const isTrueLiteral = (arg: TSESTree.CallExpressionArgument) =>
  arg.type === AST_NODE_TYPES.Literal && arg.value === true;

const isFalseLiteral = (arg: TSESTree.CallExpressionArgument) =>
  arg.type === AST_NODE_TYPES.Literal && arg.value === false;

const isExprCallback = (h: TSESTree.CallExpressionArgument) =>
  isFunctionNode(h) && h.body.type !== AST_NODE_TYPES.BlockStatement;

const isExprBranch = (step: StepKind, pred: (arg: TSESTree.CallExpressionArgument) => boolean) =>
  step.kind === "with" &&
  stepArgs(step).length === 2 &&
  O.exists(pred)(stepArgAt(step, 0)) &&
  O.exists(isExprCallback)(stepArgAt(step, 1));

const isBooleanBranchPair = (s0: StepKind, s1: StepKind) =>
  (isExprBranch(s0, isTrueLiteral) && isExprBranch(s1, isFalseLiteral)) ||
  (isExprBranch(s0, isFalseLiteral) && isExprBranch(s1, isTrueLiteral));

const isBooleanMatchChain = flow(
  (chain: MatchChain) => chain.steps,
  O.fromPredicate((steps) => steps.length === 3),
  O.bindTo("steps"),
  O.bind("s0", ({ steps }) => RA.lookup(0)(steps)),
  O.bind("s1", ({ steps }) => RA.lookup(1)(steps)),
  O.bind("s2", ({ steps }) => RA.lookup(2)(steps)),
  O.exists(({ s0, s1, s2 }) => s2.kind === "exhaustive" && isBooleanBranchPair(s0, s1)),
);

const checkBooleanMatch = (chain: MatchChain, report: ReportFn) => {
  match(isBooleanMatchChain(chain))
    .with(true, () => {
      report(chain.matchCall)("preferTernaryOverBooleanMatch");
    })
    .with(false, () => {})
    .exhaustive();
};

const runOptionalChecks = ({ chain, env }: ChainContext) => {
  match(env)
    .with({ catchAllMode: "flag" }, () => {
      checkCatchAllExhaustive(chain.steps, env.report);
    })
    .with({ catchAllMode: "skip" }, () => {})
    .exhaustive();
  match(env)
    .with({ booleanMatchMode: "flag" }, () => {
      checkBooleanMatch(chain, env.report);
    })
    .with({ booleanMatchMode: "skip" }, () => {})
    .exhaustive();
};

const runStepChecks = (steps: ReadonlyArray<StepKind>, env: CheckEnv) => {
  RA.map((step: StepKind) => {
    checkPredicateStep(env.report)(step);
    checkNestedMatch(env.report)(step);
    checkDeepDestructure(env)(step);
    return O.none;
  })(steps);
};

const runAllChainChecks = (ctx: ChainContext) => {
  checkNoMatchTrue(ctx.chain.inputArg, ctx.env.report);
  checkTypeofInput(ctx.chain.inputArg, ctx.env.report);
  checkWholeObjectMatch(ctx);
  runStepChecks(ctx.chain.steps, ctx.env);
  checkConsecutiveDuplicates(ctx.chain.steps, ctx.env);
  runOptionalChecks(ctx);
};

const buildReportFn =
  (context: Readonly<TSESLint.RuleContext<MessageIds, RuleOptions>>) =>
  (target: TSESTree.Node) =>
  (messageId: MessageIds, data?: Readonly<Record<string, string>>) => {
    context.report({ node: target, messageId, ...(data ? { data } : {}) });
  };

const toCheckEnv = (
  context: Readonly<TSESLint.RuleContext<MessageIds, RuleOptions>>,
  options: RuleOptions[number],
) =>
  ({
    sourceCode: context.sourceCode,
    visitorKeys: context.sourceCode.visitorKeys,
    catchAllMode: options.preferOtherwiseOverCatchAll ? ("flag" as const) : ("skip" as const),
    booleanMatchMode: options.preferTernaryOverBooleanMatch ? ("flag" as const) : ("skip" as const),
    report: buildReportFn(context),
  }) satisfies CheckEnv;

const inspectCallExpression = (
  context: Readonly<TSESLint.RuleContext<MessageIds, RuleOptions>>,
  options: RuleOptions[number],
) =>
  flow(
    buildMatchChain,
    O.match(
      () => {},
      (chain: MatchChain) => {
        runAllChainChecks({ chain, env: toCheckEnv(context, options) });
      },
    ),
  );

export const preferExpressiveTsPattern = createRule<RuleOptions, MessageIds>({
  name: "prefer-expressive-ts-pattern",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Encourage expressive `ts-pattern` pattern matching (`P._`, `P.string`, `P.number`, `P.select`, structural patterns) rather than using `match` as a simple `switch` substitute.",
    },
    messages: {
      noMatchTrue:
        "Avoid `match(true)`/`match(false)` as a `switch (true)` substitute. Match on the underlying values (e.g. `match({ a, b })`) using expressive `P.*` patterns.",
      preferTypeWildcard:
        "Avoid imperative type/nullish checks in `match`. Use `ts-pattern` wildcards like `{{suggestion}}` directly in `.with(...)`.",
      preferWholeObjectMatch:
        "Avoid matching on `{{objectName}}.{{propName}}` while reading `{{objectName}}` inside handlers. Match on `{{objectName}}` directly with `{ {{propName}}: ... }` and `P.select()` for type narrowing.",
      noNestedMatch:
        "Avoid nesting `match(...)` inside a branch handler. Combine inputs into a tuple `match([a, b])` or object `match({ a, b })` and match both simultaneously.",
      preferPatternOverWhen:
        "Replace this trivial `.when(...)` predicate with an expressive `ts-pattern` matcher such as `{{suggestion}}`.",
      preferMultiPatternWith:
        "Combine consecutive `.with(...)` clauses with identical handlers into a single multi-pattern `.with(p1, p2, handler)` or `P.union(...)`.",
      preferSelectOverDeepDestructure:
        "Consider using `P.select()` inside the pattern instead of deeply destructuring a single value in the handler.",
      preferOtherwiseOverCatchAll:
        "Prefer `.otherwise(handler)` instead of `.with(P._, handler).exhaustive()` for top-level catch-all defaults.",
      preferTernaryOverBooleanMatch:
        "Avoid using `match(bool)` with pure expression branches as a `switch` substitute; prefer a ternary expression `cond ? a : b`.",
    },
    schema: [
      {
        type: "object",
        properties: {
          preferOtherwiseOverCatchAll: { type: "boolean" },
          preferTernaryOverBooleanMatch: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ preferOtherwiseOverCatchAll: false, preferTernaryOverBooleanMatch: false }],
  },
  create: (context, [options]) => ({
    CallExpression: inspectCallExpression(context, options),
  }),
});
