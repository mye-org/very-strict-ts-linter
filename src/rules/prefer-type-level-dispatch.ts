import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../utils/create-rule.js";
import { isFiniteExhaustiveCandidate } from "../utils/type-helpers.js";

type MessageIds = "preferTypeLevelDispatch";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const MONADIC_TYPE_NAMES = new Set(["Option", "Either", "TaskEither", "These"]);

const isBooleanType = (type: ts.Type) =>
  Boolean(type.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral));

const isBooleanOnlyUnion = (type: ts.Type) =>
  type.isUnion() && pipe(type.types, RA.every(isBooleanType));

const isTrivialEmptyType = (type: ts.Type) =>
  Boolean(type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never));

const MONADIC_TAG_SETS = [
  new Set(["None", "Some"]),
  new Set(["Left", "Right"]),
  new Set(["Left", "Right", "Both"]),
] as const satisfies ReadonlyArray<ReadonlySet<string>>;

const getMemberTagLiteral = (member: ts.Type, checker: ts.TypeChecker) =>
  pipe(
    O.fromNullable(member.getProperty("_tag")),
    O.map((prop) => checker.getTypeOfSymbol(prop)),
    O.filter((t): t is ts.StringLiteralType => t.isStringLiteral()),
    O.map((t) => t.value),
  );

const hasAllTagsInSet = (tags: ReadonlyArray<string>, tagSet: ReadonlySet<string>) =>
  pipe(tags, RA.every((tag) => tagSet.has(tag)));

const hasMonadicTagSet = (tags: ReadonlyArray<string>) =>
  pipe(MONADIC_TAG_SETS, RA.some((set) => hasAllTagsInSet(tags, set)));

const isExpandedMonadicUnion = (type: ts.Type, checker: ts.TypeChecker) =>
  type.isUnion() &&
  pipe(
    type.types,
    RA.filterMap((m) => getMemberTagLiteral(m, checker)),
    (tags) => tags.length === type.types.length && hasMonadicTagSet(tags),
  );

const isMonadicWrapperType = (type: ts.Type, checker: ts.TypeChecker) =>
  MONADIC_TYPE_NAMES.has(type.aliasSymbol?.name ?? "") ||
  MONADIC_TYPE_NAMES.has(type.getSymbol()?.name ?? "") ||
  isExpandedMonadicUnion(type, checker);

const isStringLiteralLike = (type: ts.Type) =>
  Boolean(type.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral));

const isNumberLiteralLike = (type: ts.Type) =>
  Boolean(type.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral));

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
) => pipe(members, RA.some((b) => a !== b && isPairDistinct(a, b, checker)));

const hasHeterogeneousMembers = (members: ReadonlyArray<ts.Type>, checker: ts.TypeChecker) =>
  pipe(
    members,
    RA.some((a) => hasDistinctOther(a, members, checker)),
  );

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

const isMatchCallOnParam = (
  node: TSESTree.Node,
  paramNames: ReadonlySet<string>,
) =>
  node.type === AST_NODE_TYPES.CallExpression &&
  node.callee.type === AST_NODE_TYPES.Identifier &&
  node.callee.name === "match" &&
  node.arguments.length === 1 &&
  node.arguments[0]?.type === AST_NODE_TYPES.Identifier &&
  paramNames.has(node.arguments[0].name);

const getWithBranchArg = (call: TSESTree.CallExpression) =>
  pipe(
    O.fromNullable(call.arguments[call.arguments.length - 1]),
    O.filter((a): a is TSESTree.Expression => a.type !== AST_NODE_TYPES.SpreadElement),
  );

const getOtherwiseBranchArg = (call: TSESTree.CallExpression) =>
  pipe(
    O.fromNullable(call.arguments[0]),
    O.filter((a): a is TSESTree.Expression => a.type !== AST_NODE_TYPES.SpreadElement),
  );

const appendBranchArg = (
  arg: O.Option<TSESTree.Expression>,
  acc: ReadonlyArray<TSESTree.Expression>,
) =>
  pipe(
    arg,
    O.match(
      () => acc,
      (cb) => [...acc, cb],
    ),
  );

const getParentMethodCall = (current: TSESTree.Node) =>
  current.parent?.type === AST_NODE_TYPES.MemberExpression &&
  current.parent.object === current &&
  current.parent.property.type === AST_NODE_TYPES.Identifier &&
  current.parent.parent.type === AST_NODE_TYPES.CallExpression
    ? O.some([current.parent.property.name, current.parent.parent] as const)
    : O.none;

const stepMatchBranchCallbacks = (
  parentCall: TSESTree.CallExpression,
  acc: ReadonlyArray<TSESTree.Expression>,
) =>
  pipe(
    getWithBranchArg(parentCall),
    (arg) => appendBranchArg(arg, acc),
    (nextAcc) => getMatchBranchCallbacks(parentCall, nextAcc),
  );

const getMatchBranchCallbacks = (
  current: TSESTree.Node,
  acc: ReadonlyArray<TSESTree.Expression>,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST climb
): ReadonlyArray<TSESTree.Expression> =>
  pipe(
    getParentMethodCall(current),
    O.match(
      () => acc,
      ([method, parentCall]) =>
        match(method)
          .with("with", () => stepMatchBranchCallbacks(parentCall, acc))
          .with("otherwise", () => appendBranchArg(getOtherwiseBranchArg(parentCall), acc))
          .otherwise(() => acc),
    ),
  );

const findMatchInBlock = (b: TSESTree.BlockStatement, paramNames: ReadonlySet<string>) =>
  b.body.length === 1 && b.body[0]?.type === AST_NODE_TYPES.ReturnStatement && b.body[0].argument
    ? findMatchChainInExpr(b.body[0].argument, paramNames)
    : [];

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST search
const findMatchChainInExpr = (expr: TSESTree.Node, paramNames: ReadonlySet<string>): ReadonlyArray<ReadonlyArray<TSESTree.Expression>> =>
  isMatchCallOnParam(expr, paramNames)
    ? [getMatchBranchCallbacks(expr, [])]
    : match(expr)
        .with({ type: AST_NODE_TYPES.BlockStatement }, (b) => findMatchInBlock(b, paramNames))
        .with({ type: AST_NODE_TYPES.CallExpression }, (c) =>
          pipe(
            [c.callee, ...c.arguments] as ReadonlyArray<TSESTree.Node>,
            RA.flatMap((child) => findMatchChainInExpr(child, paramNames)),
          ),
        )
        .with({ type: AST_NODE_TYPES.MemberExpression }, (m) =>
          findMatchChainInExpr(m.object, paramNames),
        )
        .with(P._, () => [] as ReadonlyArray<ReadonlyArray<TSESTree.Expression>>)
        .exhaustive();

const getCallbackReturnType = (
  cb: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  pipe(
    checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(cb)).getCallSignatures(),
    RA.head,
    O.map((sig) => checker.getReturnTypeOfSignature(sig)),
  );

const hasAtLeastTwo = (xs: ReadonlyArray<ts.Type>) => xs.length >= 2;

const hasHeterogeneousCallbacks = (
  callbacks: ReadonlyArray<TSESTree.Expression>,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  pipe(
    callbacks,
    RA.filterMap((cb) => getCallbackReturnType(cb, services, checker)),
    (types) => hasAtLeastTwo(types) && hasHeterogeneousMembers(types, checker),
  );

const hasCorrelatedMatchBranches = (
  node: FunctionNode,
  paramNames: ReadonlySet<string>,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  pipe(
    findMatchChainInExpr(node.body, paramNames),
    RA.some((callbacks) => hasHeterogeneousCallbacks(callbacks, services, checker)),
  );

const isWideUnionReturn = (sig: ts.Signature, checker: ts.TypeChecker) => {
  const ret = checker.getReturnTypeOfSignature(sig);
  return (
    ret.isUnion() &&
    !isMonadicWrapperType(ret, checker) &&
    !isBooleanOnlyUnion(ret) &&
    pipe(
      ret.types,
      RA.filter((t) => !isTrivialEmptyType(t)),
      (members) => hasAtLeastTwo(members) && hasHeterogeneousMembers(members, checker),
    )
  );
};

const getFiniteUnionParamNames = (sig: ts.Signature, checker: ts.TypeChecker) =>
  pipe(
    sig.getParameters(),
    RA.filter((p) => isFiniteNonBooleanUnionParam(p, checker)),
    RA.map((p) => p.name),
  );

const isDispatchCandidate = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  !node.typeParameters?.params.length &&
  pipe(
    services.esTreeNodeToTSNodeMap.get(node) as ts.SignatureDeclaration,
    (tsNode) => checker.getSignatureFromDeclaration(tsNode),
    O.fromNullable,
    O.filter((sig) => isWideUnionReturn(sig, checker)),
    O.map((sig) => getFiniteUnionParamNames(sig, checker)),
    O.filter((names) => names.length > 0),
    O.map((names) => new Set(names)),
    O.exists((nameSet) => hasCorrelatedMatchBranches(node, nameSet, services, checker)),
  );

export const preferTypeLevelDispatch = createRule<[], MessageIds>({
  name: "prefer-type-level-dispatch",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Encourage generic indexed access (`<K extends keyof M>(k: K) => M[K]`) or conditional return types when a function maps a finite union parameter to distinct return types.",
    },
    messages: {
      preferTypeLevelDispatch:
        "Avoid returning a wide union from a finite-union dispatch. Use a generic type parameter with an indexed lookup (`<K extends keyof Map>(k: K) => Map[K]`) or conditional return type so callers get the exact output type at compile time.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const services = ESLintUtils.getParserServices(context);
    const check = (node: FunctionNode) => {
      pipe(
        isDispatchCandidate(node, services, services.program.getTypeChecker()),
        (flag) => {
          match(flag).with(true, () => { context.report({ node, messageId: "preferTypeLevelDispatch" }); }).with(false, () => {}).exhaustive();
        },
      );
    };
    return { FunctionDeclaration: check, FunctionExpression: check, ArrowFunctionExpression: check };
  },
});
