import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { isFiniteExhaustiveCandidate } from "../lib/finite-types.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "preferTypeLevelDispatch";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const MONADIC_TYPE_NAMES: ReadonlySet<string> = new Set(["Option", "Either", "TaskEither", "These"]);
const MATCH_CALLEES: ReadonlySet<string> = new Set(["match"]);
const WITH_METHODS: ReadonlySet<string> = new Set(["with"]);
const OTHERWISE_METHODS: ReadonlySet<string> = new Set(["otherwise"]);

const isBooleanType = (type: ts.Type) =>
  (type.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !== 0;

const isBooleanOnlyUnion = (type: ts.Type) =>
  type.isUnion() && RA.every(isBooleanType)(type.types);

const isTrivialEmptyType = (type: ts.Type) =>
  (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0;

const MONADIC_TAG_SETS = [
  new Set(["None", "Some"]),
  new Set(["Left", "Right"]),
  new Set(["Left", "Right", "Both"]),
] as const satisfies ReadonlyArray<ReadonlySet<string>>;

const extractMemberTagLiteral = (member: ts.Type, checker: ts.TypeChecker) =>
  flow(
    (m: ts.Type) => m.getProperty("_tag"),
    O.fromNullable,
    O.map((prop) => checker.getTypeOfSymbol(prop)),
    O.filter((t): t is ts.StringLiteralType => t.isStringLiteral()),
    O.map((t) => t.value),
  )(member);

const hasAllTagsInSet = (tags: ReadonlyArray<string>, tagSet: ReadonlySet<string>) =>
  RA.every((tag: string) => tagSet.has(tag))(tags);

const hasMonadicTagSet = (tags: ReadonlyArray<string>) =>
  RA.some((set: ReadonlySet<string>) => hasAllTagsInSet(tags, set))(MONADIC_TAG_SETS);

const hasFullMonadicTags = (tags: ReadonlyArray<string>, expectedCount: number) =>
  tags.length === expectedCount && hasMonadicTagSet(tags);

const isExpandedMonadicUnion = (type: ts.Type, checker: ts.TypeChecker) =>
  type.isUnion() &&
  hasFullMonadicTags(
    RA.filterMap((m: ts.Type) => extractMemberTagLiteral(m, checker))(type.types),
    type.types.length,
  );

const isMonadicWrapperType = (type: ts.Type, checker: ts.TypeChecker) =>
  MONADIC_TYPE_NAMES.has(type.aliasSymbol?.name ?? "") ||
  MONADIC_TYPE_NAMES.has(type.getSymbol()?.name ?? "") ||
  isExpandedMonadicUnion(type, checker);

const isStringLiteralLike = (type: ts.Type) =>
  (type.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) !== 0;

const isNumberLiteralLike = (type: ts.Type) =>
  (type.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) !== 0;

const isSamePrimitiveFamily = (a: ts.Type, b: ts.Type) =>
  (isStringLiteralLike(a) && isStringLiteralLike(b)) ||
  (isNumberLiteralLike(a) && isNumberLiteralLike(b)) ||
  (isBooleanType(a) && isBooleanType(b));

const isPairDistinct = (a: ts.Type, b: ts.Type, checker: ts.TypeChecker) =>
  !isSamePrimitiveFamily(a, b) &&
  (!checker.isTypeAssignableTo(a, b) || !checker.isTypeAssignableTo(b, a));

const hasDistinctOther = (
  a: ts.Type,
  members: ReadonlyArray<ts.Type>,
  checker: ts.TypeChecker,
) => RA.some((b: ts.Type) => a !== b && isPairDistinct(a, b, checker))(members);

const hasHeterogeneousMembers = (members: ReadonlyArray<ts.Type>, checker: ts.TypeChecker) =>
  RA.some((a: ts.Type) => hasDistinctOther(a, members, checker))(members);

const isFiniteNonBooleanUnionParam = (
  param: ts.Symbol,
  checker: ts.TypeChecker,
) => {
  const paramType = checker.getTypeOfSymbol(param);
  return (
    paramType.isUnion() &&
    paramType.types.length >= 2 &&
    !isBooleanOnlyUnion(paramType) &&
    isFiniteExhaustiveCandidate(paramType)
  );
};

const isArgInParamSet = (
  paramNames: ReadonlySet<string>,
  arg?: TSESTree.CallExpressionArgument,
) => arg?.type === AST_NODE_TYPES.Identifier && paramNames.has(arg.name);

const isMatchCallOnParam = (
  node: TSESTree.Node,
  paramNames: ReadonlySet<string>,
) =>
  node.type === AST_NODE_TYPES.CallExpression &&
  node.callee.type === AST_NODE_TYPES.Identifier &&
  MATCH_CALLEES.has(node.callee.name) &&
  node.arguments.length === 1 &&
  isArgInParamSet(paramNames, node.arguments[0]);

const extractWithBranchArg = flow(
  (call: TSESTree.CallExpression) => call.arguments[call.arguments.length - 1],
  O.fromNullable,
  O.filter((a): a is TSESTree.Expression => a.type !== AST_NODE_TYPES.SpreadElement),
);

const extractOtherwiseBranchArg = flow(
  (call: TSESTree.CallExpression) => call.arguments[0],
  O.fromNullable,
  O.filter((a): a is TSESTree.Expression => a.type !== AST_NODE_TYPES.SpreadElement),
);

const appendBranchArg = (
  arg: O.Option<TSESTree.Expression>,
  acc: ReadonlyArray<TSESTree.Expression>,
) =>
  O.match(
    () => acc,
    (cb: TSESTree.Expression) => [...acc, cb],
  )(arg);

const resolveMemberParentCall = (member: TSESTree.MemberExpression, current: TSESTree.Node) =>
  member.object === current &&
  member.property.type === AST_NODE_TYPES.Identifier &&
  member.parent.type === AST_NODE_TYPES.CallExpression
    ? O.some([member.property.name, member.parent] as const)
    : O.none;

const resolveParentMethodCall = (current: TSESTree.Node) =>
  current.parent?.type === AST_NODE_TYPES.MemberExpression
    ? resolveMemberParentCall(current.parent, current)
    : O.none;

const stepMatchBranchCallbacks = (
  parentCall: TSESTree.CallExpression,
  acc: ReadonlyArray<TSESTree.Expression>,
) =>
  flow(
    extractWithBranchArg,
    (arg) => appendBranchArg(arg, acc),
    (nextAcc) => collectMatchBranchCallbacks(parentCall, nextAcc),
  )(parentCall);

const collectMatchBranchCallbacks = (
  current: TSESTree.Node,
  acc: ReadonlyArray<TSESTree.Expression>,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST climb
): ReadonlyArray<TSESTree.Expression> =>
  flow(
    resolveParentMethodCall,
    O.match(
      () => acc,
      ([method, parentCall]) =>
        match(method)
          .with(P.when((m) => WITH_METHODS.has(m)), () => stepMatchBranchCallbacks(parentCall, acc))
          .with(P.when((m) => OTHERWISE_METHODS.has(m)), () =>
            appendBranchArg(extractOtherwiseBranchArg(parentCall), acc),
          )
          .otherwise(() => acc),
    ),
  )(current);

const extractSingleReturnArg = (block: TSESTree.BlockStatement) =>
  block.body.length === 1
    ? flow(
        RA.head<TSESTree.Statement>,
        O.filter((s): s is TSESTree.ReturnStatement => s.type === AST_NODE_TYPES.ReturnStatement),
        O.flatMap((s) => O.fromNullable(s.argument)),
      )(block.body)
    : O.none;

const findMatchInBlock = (b: TSESTree.BlockStatement, paramNames: ReadonlySet<string>) =>
  flow(
    extractSingleReturnArg,
    O.match(
      () => [] as ReadonlyArray<ReadonlyArray<TSESTree.Expression>>,
      (arg) => findMatchChainInExpr(arg, paramNames),
    ),
  )(b);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST search
const findMatchChainInExpr = (expr: TSESTree.Node, paramNames: ReadonlySet<string>): ReadonlyArray<ReadonlyArray<TSESTree.Expression>> =>
  isMatchCallOnParam(expr, paramNames)
    ? [collectMatchBranchCallbacks(expr, [])]
    : match(expr)
        .with({ type: AST_NODE_TYPES.BlockStatement }, (b) => findMatchInBlock(b, paramNames))
        .with({ type: AST_NODE_TYPES.CallExpression }, (c) =>
          RA.flatMap((child: TSESTree.Node) => findMatchChainInExpr(child, paramNames))([
            c.callee,
            ...c.arguments,
          ]),
        )
        .with({ type: AST_NODE_TYPES.MemberExpression }, (m) =>
          findMatchChainInExpr(m.object, paramNames),
        )
        .with(P._, () => [] as ReadonlyArray<ReadonlyArray<TSESTree.Expression>>)
        .exhaustive();

const resolveCallbackReturnType = (
  cb: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  flow(
    RA.head<ts.Signature>,
    O.map((sig) => checker.getReturnTypeOfSignature(sig)),
  )(checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(cb)).getCallSignatures());

const hasAtLeastTwo = (xs: ReadonlyArray<ts.Type>) => xs.length >= 2;

const hasMultipleHeterogeneous = (members: ReadonlyArray<ts.Type>, checker: ts.TypeChecker) =>
  hasAtLeastTwo(members) && hasHeterogeneousMembers(members, checker);

const hasHeterogeneousCallbacks = (
  callbacks: ReadonlyArray<TSESTree.Expression>,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  hasMultipleHeterogeneous(
    RA.filterMap((cb: TSESTree.Expression) => resolveCallbackReturnType(cb, services, checker))(
      callbacks,
    ),
    checker,
  );

const hasCorrelatedMatchBranches = (
  node: FunctionNode,
  paramNames: ReadonlySet<string>,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  RA.some((callbacks: ReadonlyArray<TSESTree.Expression>) =>
    hasHeterogeneousCallbacks(callbacks, services, checker),
  )(findMatchChainInExpr(node.body, paramNames));

const isWideUnionReturn = (sig: ts.Signature, checker: ts.TypeChecker) => {
  const ret = checker.getReturnTypeOfSignature(sig);
  return (
    ret.isUnion() &&
    !isMonadicWrapperType(ret, checker) &&
    !isBooleanOnlyUnion(ret) &&
    hasMultipleHeterogeneous(
      RA.filter((t: ts.Type) => !isTrivialEmptyType(t))(ret.types),
      checker,
    )
  );
};

const collectFiniteUnionParamNames = (sig: ts.Signature, checker: ts.TypeChecker) =>
  RA.filterMap((p: ts.Symbol) =>
    isFiniteNonBooleanUnionParam(p, checker) ? O.some(p.name) : O.none,
  )(sig.getParameters());

const hasFunctionTypeParams = flow(
  (node: FunctionNode) => node.typeParameters,
  O.fromNullable,
  O.exists((tp) => tp.params.length > 0),
);

const resolveFunctionSignature = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  flow(
    (n: FunctionNode) => services.esTreeNodeToTSNodeMap.get(n),
    (tsNode) => checker.getSignatureFromDeclaration(tsNode),
    O.fromNullable,
  )(node);

const isDispatchCandidate = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  !hasFunctionTypeParams(node) &&
  flow(
    O.filter((sig: ts.Signature) => isWideUnionReturn(sig, checker)),
    O.map((sig) => collectFiniteUnionParamNames(sig, checker)),
    O.filter((names) => names.length > 0),
    O.map((names) => new Set(names)),
    O.exists((nameSet) => hasCorrelatedMatchBranches(node, nameSet, services, checker)),
  )(resolveFunctionSignature(node, services, checker));

const isDispatchCandidateNode = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
) => isDispatchCandidate(node, services, services.program.getTypeChecker());

const checkDispatchFunction = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
  report: (n: FunctionNode) => void,
) => {
  match(isDispatchCandidateNode(node, services))
    .with(true, () => { report(node); })
    .with(false, () => {})
    .exhaustive();
};

export const preferTypeLevelDispatch = createRule<[], MessageIds>({
  name: "prefer-type-level-dispatch",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Encourage generic indexed access (`<K extends keyof typeof map>(k: K) => map[k]`) when a function maps a finite union parameter to distinct return types.",
    },
    messages: {
      preferTypeLevelDispatch:
        "Avoid returning a wide union from a finite-union dispatch. Use a generic indexed lookup (`<K extends keyof typeof map>(k: K) => map[k]`) so TypeScript infers the exact output type at compile time.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const check = (node: FunctionNode) => {
      checkDispatchFunction(node, ESLintUtils.getParserServices(context), (n) => {
        context.report({ node: n, messageId: "preferTypeLevelDispatch" });
      });
    };
    return { FunctionDeclaration: check, FunctionExpression: check, ArrowFunctionExpression: check };
  },
});
