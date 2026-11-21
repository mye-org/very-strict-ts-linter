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
import {
  getEnclosingEsTreeFunction,
  isInsideUnsafeOrMustFunction,
  isTsParameterSymbol,
  isUnsafeOrMustName,
} from "../utils/type-helpers.js";

type MessageIds = "preferTemplateLiteralUnion" | "preferTemplateLiteralGuard";

const DELIMITERS = [":", "/", ".", "-", "_"] as const;
const EXEMPT_FN_PREFIX_RE = /^(is|has|can|should|parse|decode|from)(?=$|[A-Z0-9_])/;
const GUARD_STRING_METHODS = new Set(["startsWith", "endsWith"]);
const COLLECTION_CALLBACK_METHODS = new Set(["filter", "some", "every", "find", "findFirst", "exists"]);
const ANCHORED_LITERAL_REGEX_RE = /^(\^[A-Za-z0-9_/:.-]+|[A-Za-z0-9_/:.-]+\$)$/;

const extractStringLiteral = (node: TSESTree.TypeNode) =>
  node.type === AST_NODE_TYPES.TSLiteralType &&
  node.literal.type === AST_NODE_TYPES.Literal &&
  typeof node.literal.value === "string"
    ? O.some(node.literal.value)
    : O.none;

const hasFullCartesianCounts = (
  partsList: ReadonlyArray<ReadonlyArray<string>>,
  uniqueCount: number,
) => {
  const prefixes = new Set(pipe(partsList, RA.filterMap((p) => O.fromNullable(p[0]))));
  const suffixes = new Set(pipe(partsList, RA.filterMap((p) => O.fromNullable(p[1]))));
  return (
    prefixes.size >= 2 &&
    suffixes.size >= 2 &&
    prefixes.size * suffixes.size === uniqueCount
  );
};

const isCartesianProductForDelimiter = (
  values: ReadonlyArray<string>,
  delimiter: string,
) =>
  pipe(
    values,
    RA.map((v) => v.split(delimiter)),
    (partsList) =>
      pipe(partsList, RA.every((p) => p.length === 2 && Boolean(p[0]) && Boolean(p[1]))) &&
      hasFullCartesianCounts(partsList, new Set(values).size),
  );

const isCartesianStringUnion = (node: TSESTree.TSUnionType) =>
  node.types.length >= 4 &&
  pipe(
    node.types,
    RA.filterMap(extractStringLiteral),
    (values) =>
      values.length === node.types.length &&
      pipe(DELIMITERS, RA.some((d) => isCartesianProductForDelimiter(values, d))),
  );

const getFunctionName = (fn: TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression) =>
  match(fn)
    .with({ type: AST_NODE_TYPES.FunctionDeclaration }, (f) => O.fromNullable(f.id?.name))
    .with({ parent: { type: AST_NODE_TYPES.VariableDeclarator, id: { type: AST_NODE_TYPES.Identifier } } }, (f) =>
      O.some(f.parent.id.name),
    )
    .with(P._, () => O.none)
    .exhaustive();

const isCollectionCallbackFn = (fn: TSESTree.Node) =>
  fn.parent?.type === AST_NODE_TYPES.CallExpression &&
  fn.parent.callee.type === AST_NODE_TYPES.MemberExpression &&
  fn.parent.callee.property.type === AST_NODE_TYPES.Identifier &&
  COLLECTION_CALLBACK_METHODS.has(fn.parent.callee.property.name);

const isExemptEnclosingFunction = (node: TSESTree.Node) =>
  isInsideUnsafeOrMustFunction(node) ||
  pipe(
    getEnclosingEsTreeFunction(node),
    O.exists(
      (fn) =>
        isCollectionCallbackFn(fn) ||
        pipe(
          getFunctionName(fn),
          O.exists((name) => isUnsafeOrMustName(name) || EXEMPT_FN_PREFIX_RE.test(name)),
        ),
    ),
  );

const isStringTypedParamTsNode = (
  tsNode: ts.Node,
  checker: ts.TypeChecker,
) =>
  pipe(
    O.fromNullable(checker.getSymbolAtLocation(tsNode)),
    O.exists(
      (sym) =>
        isTsParameterSymbol(sym) &&
        Boolean(checker.getTypeAtLocation(tsNode).flags & ts.TypeFlags.String),
    ),
  );

const isPlainStringParamIdentifier = (
  target: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) =>
  target.type === AST_NODE_TYPES.Identifier &&
  isStringTypedParamTsNode(
    services.esTreeNodeToTSNodeMap.get(target),
    services.program.getTypeChecker(),
  );

const isNonEmptyStringArg = (arg: O.Option<TSESTree.CallExpressionArgument>) =>
  pipe(
    arg,
    O.exists(
      (a) => a.type === AST_NODE_TYPES.Literal && typeof a.value === "string" && a.value.length > 0,
    ),
  );

const isAnchoredRegexLiteral = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.Literal &&
  "regex" in expr &&
  ANCHORED_LITERAL_REGEX_RE.test(expr.regex.pattern);

const isGuardMemberCall = (
  callee: TSESTree.MemberExpression,
  arg0: O.Option<TSESTree.CallExpressionArgument>,
  services: ParserServicesWithTypeInformation,
) =>
  callee.property.type === AST_NODE_TYPES.Identifier &&
  match(callee.property.name)
    .with(P.when((m) => GUARD_STRING_METHODS.has(m)), () =>
      isNonEmptyStringArg(arg0) && isPlainStringParamIdentifier(callee.object, services),
    )
    .with("test", () =>
      isAnchoredRegexLiteral(callee.object) &&
      pipe(arg0, O.exists((a) => isPlainStringParamIdentifier(a, services))),
    )
    .otherwise(() => false);

const isTemplateGuardCall = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) =>
  !isExemptEnclosingFunction(node) &&
  node.callee.type === AST_NODE_TYPES.MemberExpression &&
  isGuardMemberCall(node.callee, O.fromNullable(node.arguments[0]), services);

const reportOpt = (
  node: TSESTree.Node,
  msg: O.Option<MessageIds>,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  pipe(msg, O.map((messageId) => { report({ node, messageId }); }));
};

export const preferTemplateLiteralType = createRule<[], MessageIds>({
  name: "prefer-template-literal-type",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Encourage TypeScript template literal types over cross-product string literal unions and runtime prefix/suffix checks on plain `string` parameters.",
    },
    messages: {
      preferTemplateLiteralUnion:
        "Replace this cross-product string literal union with a template literal type (e.g. `` `${Prefix}:${Suffix}` ``).",
      preferTemplateLiteralGuard:
        "Avoid runtime prefix/suffix validation on a plain `string` parameter in domain logic. Constrain the parameter with a template literal type (e.g. `` `prefix_${string}` ``) so invalid formats fail at compile time.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const rep = (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => { context.report(d); };
    return {
      TSUnionType: (node) => { reportOpt(node, isCartesianStringUnion(node) ? O.some("preferTemplateLiteralUnion") : O.none, rep); },
      CallExpression: (node) => { reportOpt(node, isTemplateGuardCall(node, ESLintUtils.getParserServices(context)) ? O.some("preferTemplateLiteralGuard") : O.none, rep); },
    };
  },
});
