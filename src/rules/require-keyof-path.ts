import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { createRule } from "../lib/rule-factory.js";
import { isTsParameterSymbol } from "../lib/ts-parameter-symbol.js";
import { isInsideUnsafeOrMustFunction, isUnsafeOrMustName } from "../lib/unsafe-function-scope.js";

type MessageIds = "requireKeyofParam" | "requireTypedPathParam";

const SPLIT_METHODS: ReadonlySet<string> = new Set(["split"]);

const resolveParamSymbol = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => {
  const resolve = flow(
    (n: TSESTree.Node) => services.esTreeNodeToTSNodeMap.get(n),
    (tsNode) => services.program.getTypeChecker().getSymbolAtLocation(tsNode),
    O.fromNullable,
    O.filter(isTsParameterSymbol),
  );
  return resolve(node);
};

const isStringType = (type: ts.Type) => (type.flags & ts.TypeFlags.String) !== 0;

const isObjectLikeType = (type: ts.Type, checker: ts.TypeChecker) =>
  (type.flags & (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean)) === 0 &&
  !checker.isArrayType(type) &&
  ((type.flags & (ts.TypeFlags.Object | ts.TypeFlags.TypeParameter)) !== 0 ||
    type.getProperties().length > 0);

const isUnsafeNamedParent = (parent: ts.Node) =>
  (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) &&
  parent.name !== undefined &&
  ts.isIdentifier(parent.name) &&
  isUnsafeOrMustName(parent.name.text);

const isEnclosingFnUnsafe = ({ parent }: ts.Declaration) =>
  ts.isFunctionLike(parent) && isUnsafeNamedParent(parent);

const isMatchingParamPair = ({
  objSym,
  keySym,
  checker,
}: Readonly<{
  objSym: ts.Symbol;
  keySym: ts.Symbol;
  checker: ts.TypeChecker;
}>) =>
  objSym.valueDeclaration !== undefined &&
  keySym.valueDeclaration !== undefined &&
  objSym.valueDeclaration.parent === keySym.valueDeclaration.parent &&
  !isEnclosingFnUnsafe(keySym.valueDeclaration) &&
  isObjectLikeType(checker.getTypeOfSymbol(objSym), checker) &&
  isStringType(checker.getTypeOfSymbol(keySym));

const isPairFromSameFn = ({
  objNode,
  keyNode,
  services,
}: Readonly<{
  objNode: TSESTree.Identifier;
  keyNode: TSESTree.Identifier;
  services: ParserServicesWithTypeInformation;
}>) => {
  const check = flow(
    O.apS("objSym", resolveParamSymbol(objNode, services)),
    O.apS("keySym", resolveParamSymbol(keyNode, services)),
    O.exists(({ objSym, keySym }) =>
      isMatchingParamPair({ objSym, keySym, checker: services.program.getTypeChecker() }),
    ),
  );
  return check(O.Do);
};

const hasObjectLikeParam = (
  params: ReadonlyArray<ts.ParameterDeclaration>,
  checker: ts.TypeChecker,
) =>
  RA.some(
    flow(
      (p: ts.ParameterDeclaration) => checker.getTypeAtLocation(p),
      (t) => isObjectLikeType(t, checker),
    ),
  )(params);

const isSplitKeyDecl = (decl: ts.Declaration, checker: ts.TypeChecker) =>
  ts.isFunctionLike(decl.parent) &&
  !isEnclosingFnUnsafe(decl) &&
  hasObjectLikeParam(decl.parent.parameters, checker);

const isSplitKeyParam = (
  keySym: ts.Symbol,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  return (
    keySym.valueDeclaration !== undefined &&
    isStringType(checker.getTypeOfSymbol(keySym)) &&
    isSplitKeyDecl(keySym.valueDeclaration, checker)
  );
};

const isDotLiteralArg = (arg?: TSESTree.CallExpressionArgument) =>
  arg?.type === AST_NODE_TYPES.Literal && arg.value === ".";

const isSplitCallOnParam = (
  callee: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  callee.object.type === AST_NODE_TYPES.Identifier &&
  callee.property.type === AST_NODE_TYPES.Identifier &&
  SPLIT_METHODS.has(callee.property.name) &&
  O.exists((keySym: ts.Symbol) => isSplitKeyParam(keySym, services))(
    resolveParamSymbol(callee.object, services),
  );

const isDotPathSplitOnParam = (
  call: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) => isDotLiteralArg(call.arguments[0]) && isSplitCallOnParam(call.callee, services);

const reportOpt =
  (report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void) =>
  (node: TSESTree.Node, msg: O.Option<MessageIds>) => {
    O.map((messageId: MessageIds) => { report({ node, messageId }); })(msg);
  };

const isComputedParamIndex = (
  node: TSESTree.MemberExpression,
  services: ParserServicesWithTypeInformation,
) =>
  !isInsideUnsafeOrMustFunction(node) &&
  node.computed &&
  node.object.type === AST_NODE_TYPES.Identifier &&
  node.property.type === AST_NODE_TYPES.Identifier &&
  isPairFromSameFn({ objNode: node.object, keyNode: node.property, services });

const isInParamCheck = (
  node: TSESTree.BinaryExpression,
  services: ParserServicesWithTypeInformation,
) =>
  !isInsideUnsafeOrMustFunction(node) &&
  node.operator === "in" &&
  node.left.type === AST_NODE_TYPES.Identifier &&
  node.right.type === AST_NODE_TYPES.Identifier &&
  isPairFromSameFn({ objNode: node.right, keyNode: node.left, services });

export const requireKeyofPath = createRule<[], MessageIds>({
  name: "require-keyof-path",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require `K extends keyof T` or recursive template-literal `Path<T>` types instead of raw `string` when indexing or traversing object properties.",
    },
    messages: {
      requireKeyofParam:
        "Avoid raw `string` for object property lookup. Constrain this parameter with `<K extends keyof T>` so invalid keys fail at compile time.",
      requireTypedPathParam:
        "Avoid splitting a raw `string` dot-path for object traversal. Use a recursive template-literal `Path<T>` or tuple path type (`monocle-ts` `Lens.fromPath`).",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const services = ESLintUtils.getParserServices(context);
    const rep = reportOpt((d) => { context.report(d); });
    return {
      MemberExpression: (node) => { rep(node.property, isComputedParamIndex(node, services) ? O.some("requireKeyofParam") : O.none); },
      BinaryExpression: (node) => { rep(node.left, isInParamCheck(node, services) ? O.some("requireKeyofParam") : O.none); },
      CallExpression: (node) => { rep(node.callee, !isInsideUnsafeOrMustFunction(node) && isDotPathSplitOnParam(node, services) ? O.some("requireTypedPathParam") : O.none); },
    };
  },
});
