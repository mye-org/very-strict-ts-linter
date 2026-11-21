import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow, pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { createRule } from "../utils/create-rule.js";
import {
  isInsideUnsafeOrMustFunction,
  isTsParameterSymbol,
  isUnsafeOrMustName,
} from "../utils/type-helpers.js";

type MessageIds = "requireKeyofParam" | "requireTypedPathParam";

const getParamSymbol = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) =>
  pipe(
    services.program.getTypeChecker().getSymbolAtLocation(services.esTreeNodeToTSNodeMap.get(node)),
    O.fromNullable,
    O.filter(isTsParameterSymbol),
  );

const isStringType = (type: ts.Type) => Boolean(type.flags & ts.TypeFlags.String);

const isObjectLikeType = (type: ts.Type, checker: ts.TypeChecker) =>
  !(type.flags & (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean)) &&
  !checker.isArrayType(type) &&
  (Boolean(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.TypeParameter)) ||
    type.getProperties().length > 0);

const isEnclosingFnUnsafe = (decl: ts.Declaration) =>
  ts.isFunctionLike(decl.parent) &&
  Boolean(
    (ts.isFunctionDeclaration(decl.parent) || ts.isMethodDeclaration(decl.parent)) &&
      decl.parent.name &&
      ts.isIdentifier(decl.parent.name) &&
      isUnsafeOrMustName(decl.parent.name.text),
  );

const isMatchingParamPair = (
  objSym: ts.Symbol,
  keySym: ts.Symbol,
  checker: ts.TypeChecker,
) =>
  Boolean(
    objSym.valueDeclaration &&
      keySym.valueDeclaration &&
      objSym.valueDeclaration.parent === keySym.valueDeclaration.parent &&
      !isEnclosingFnUnsafe(keySym.valueDeclaration) &&
      isObjectLikeType(checker.getTypeOfSymbol(objSym), checker) &&
      isStringType(checker.getTypeOfSymbol(keySym)),
  );

const isPairFromSameFn = (
  objNode: TSESTree.Identifier,
  keyNode: TSESTree.Identifier,
  services: ParserServicesWithTypeInformation,
) =>
  pipe(
    O.Do,
    O.apS("objSym", getParamSymbol(objNode, services)),
    O.apS("keySym", getParamSymbol(keyNode, services)),
    O.exists(({ objSym, keySym }) =>
      isMatchingParamPair(objSym, keySym, services.program.getTypeChecker()),
    ),
  );

const isSplitKeyParam = (
  keySym: ts.Symbol,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  return Boolean(
    keySym.valueDeclaration &&
      ts.isFunctionLike(keySym.valueDeclaration.parent) &&
      !isEnclosingFnUnsafe(keySym.valueDeclaration) &&
      isStringType(checker.getTypeOfSymbol(keySym)) &&
      pipe(
        keySym.valueDeclaration.parent.parameters,
        RA.some(flow((p) => checker.getTypeAtLocation(p), (t) => isObjectLikeType(t, checker))),
      ),
  );
};

const isDotPathSplitOnParam = (
  call: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) =>
  call.callee.type === AST_NODE_TYPES.MemberExpression &&
  call.callee.object.type === AST_NODE_TYPES.Identifier &&
  call.callee.property.type === AST_NODE_TYPES.Identifier &&
  call.callee.property.name === "split" &&
  call.arguments[0]?.type === AST_NODE_TYPES.Literal &&
  call.arguments[0].value === "." &&
  pipe(
    getParamSymbol(call.callee.object, services),
    O.exists((keySym) => isSplitKeyParam(keySym, services)),
  );

const reportOpt = (
  node: TSESTree.Node,
  msg: O.Option<MessageIds>,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  pipe(msg, O.map((messageId) => { report({ node, messageId }); }));
};

const isComputedParamIndex = (
  node: TSESTree.MemberExpression,
  services: ParserServicesWithTypeInformation,
) =>
  !isInsideUnsafeOrMustFunction(node) &&
  node.computed &&
  node.object.type === AST_NODE_TYPES.Identifier &&
  node.property.type === AST_NODE_TYPES.Identifier &&
  isPairFromSameFn(node.object, node.property, services);

const isInParamCheck = (
  node: TSESTree.BinaryExpression,
  services: ParserServicesWithTypeInformation,
) =>
  !isInsideUnsafeOrMustFunction(node) &&
  node.operator === "in" &&
  node.left.type === AST_NODE_TYPES.Identifier &&
  node.right.type === AST_NODE_TYPES.Identifier &&
  isPairFromSameFn(node.right, node.left, services);

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
    const rep = (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => { context.report(d); };
    return {
      MemberExpression: (node) => { reportOpt(node.property, isComputedParamIndex(node, services) ? O.some("requireKeyofParam") : O.none, rep); },
      BinaryExpression: (node) => { reportOpt(node.left, isInParamCheck(node, services) ? O.some("requireKeyofParam") : O.none, rep); },
      CallExpression: (node) => { reportOpt(node.callee, !isInsideUnsafeOrMustFunction(node) && isDotPathSplitOnParam(node, services) ? O.some("requireTypedPathParam") : O.none, rep); },
    };
  },
});
