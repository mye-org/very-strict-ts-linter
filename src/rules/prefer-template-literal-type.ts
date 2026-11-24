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
import { resolveEnclosingEsTreeFunction } from "../lib/estree-function-nodes.js";
import { createRule } from "../lib/rule-factory.js";
import { isTsParameterSymbol } from "../lib/ts-parameter-symbol.js";
import {
  hasMatchingEnclosingFunctionName,
  isInsideUnsafeOrMustFunction,
  isUnsafeOrMustName,
} from "../lib/unsafe-function-scope.js";

type MessageIds = "preferTemplateLiteralUnion" | "preferTemplateLiteralGuard";

const DELIMITERS = [":", "/", ".", "-", "_"] as const;
const EXEMPT_FN_PREFIX_RE = /^(is|has|can|should|parse|decode|from)(?=$|[A-Z0-9_])/;
const GUARD_STRING_METHODS: ReadonlySet<string> = new Set(["startsWith", "endsWith"]);
const REGEX_TEST_METHODS: ReadonlySet<string> = new Set(["test"]);
const COLLECTION_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  "filter",
  "some",
  "every",
  "find",
  "findFirst",
  "exists",
]);
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
  const prefixes = new Set(RA.filterMap((p: ReadonlyArray<string>) => O.fromNullable(p[0]))(partsList));
  const suffixes = new Set(RA.filterMap((p: ReadonlyArray<string>) => O.fromNullable(p[1]))(partsList));
  return (
    prefixes.size >= 2 &&
    suffixes.size >= 2 &&
    prefixes.size * suffixes.size === uniqueCount
  );
};

const isValidSplitList = RA.every(
  (p: ReadonlyArray<string>) => p.length === 2 && Boolean(p[0]) && Boolean(p[1]),
);

const isCartesianParts = (partsList: ReadonlyArray<ReadonlyArray<string>>, uniqueCount: number) =>
  isValidSplitList(partsList) && hasFullCartesianCounts(partsList, uniqueCount);

const splitByDelimiter = (delimiter: string) => (value: string) => value.split(delimiter);

const splitValuesByDelimiter = (values: ReadonlyArray<string>, delimiter: string) =>
  RA.map(splitByDelimiter(delimiter))(values);

const isCartesianProductForDelimiter = (
  values: ReadonlyArray<string>,
  delimiter: string,
) => isCartesianParts(splitValuesByDelimiter(values, delimiter), new Set(values).size);

const hasAnyDelimiterCartesian = (values: ReadonlyArray<string>) =>
  RA.some((d: string) => isCartesianProductForDelimiter(values, d))(DELIMITERS);

const isFullCartesianUnion = (values: ReadonlyArray<string>, expectedCount: number) =>
  values.length === expectedCount && hasAnyDelimiterCartesian(values);

const isCartesianStringUnion = (node: TSESTree.TSUnionType) =>
  node.types.length >= 4 &&
  isFullCartesianUnion(RA.filterMap(extractStringLiteral)(node.types), node.types.length);

const isCollectionMemberCallee = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  callee.property.type === AST_NODE_TYPES.Identifier &&
  COLLECTION_CALLBACK_METHODS.has(callee.property.name);

const isCollectionCallbackFn = ({ parent }: TSESTree.Node) =>
  O.exists(
    (p: TSESTree.Node) =>
      p.type === AST_NODE_TYPES.CallExpression && isCollectionMemberCallee(p.callee),
  )(O.fromNullable(parent));

const isExemptPrefixName = (name: string) => EXEMPT_FN_PREFIX_RE.test(name);

const isInsideCollectionCallback = flow(
  resolveEnclosingEsTreeFunction,
  O.exists(isCollectionCallbackFn),
);

const isExemptEnclosingFunction = (node: TSESTree.Node) =>
  isInsideUnsafeOrMustFunction(node) ||
  hasMatchingEnclosingFunctionName(
    node,
    (name) => isUnsafeOrMustName(name) || isExemptPrefixName(name),
  ) ||
  isInsideCollectionCallback(node);

const isStringTsType = (type: ts.Type) => (type.flags & ts.TypeFlags.String) !== 0;

const isStringTypedParamTsNode = (
  tsNode: ts.Node,
  checker: ts.TypeChecker,
) => {
  const check = flow(
    (n: ts.Node) => checker.getSymbolAtLocation(n),
    O.fromNullable,
    O.exists(
      (sym) => isTsParameterSymbol(sym) && isStringTsType(checker.getTypeAtLocation(tsNode)),
    ),
  );
  return check(tsNode);
};

const isPlainStringParamIdentifier = (
  target: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) =>
  target.type === AST_NODE_TYPES.Identifier &&
  isStringTypedParamTsNode(
    services.esTreeNodeToTSNodeMap.get(target),
    services.program.getTypeChecker(),
  );

const isNonEmptyStringArg = O.exists(
  (a: TSESTree.CallExpressionArgument) =>
    a.type === AST_NODE_TYPES.Literal && typeof a.value === "string" && a.value.length > 0,
);

const isAnchoredRegexLiteral = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.Literal &&
  "regex" in expr &&
  ANCHORED_LITERAL_REGEX_RE.test(expr.regex.pattern);

const isGuardMemberCall = ({
  callee,
  arg0,
  services,
}: Readonly<{
  callee: TSESTree.MemberExpression;
  arg0: O.Option<TSESTree.CallExpressionArgument>;
  services: ParserServicesWithTypeInformation;
}>) =>
  callee.property.type === AST_NODE_TYPES.Identifier &&
  match(callee.property.name)
    .with(P.when((m) => GUARD_STRING_METHODS.has(m)), () =>
      isNonEmptyStringArg(arg0) && isPlainStringParamIdentifier(callee.object, services),
    )
    .with(P.when((m) => REGEX_TEST_METHODS.has(m)), () =>
      isAnchoredRegexLiteral(callee.object) &&
      O.exists((a: TSESTree.CallExpressionArgument) => isPlainStringParamIdentifier(a, services))(arg0),
    )
    .otherwise(() => false);

const isTemplateGuardCall = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) =>
  !isExemptEnclosingFunction(node) &&
  node.callee.type === AST_NODE_TYPES.MemberExpression &&
  isGuardMemberCall({ callee: node.callee, arg0: O.fromNullable(node.arguments[0]), services });

const reportOpt =
  (report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void) =>
  (node: TSESTree.Node, msg: O.Option<MessageIds>) => {
    O.map((messageId: MessageIds) => { report({ node, messageId }); })(msg);
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
    const rep = reportOpt((d) => { context.report(d); });
    return {
      TSUnionType: (node) => { rep(node, isCartesianStringUnion(node) ? O.some("preferTemplateLiteralUnion") : O.none); },
      CallExpression: (node) => {
        rep(
          node,
          isTemplateGuardCall(node, ESLintUtils.getParserServices(context))
            ? O.some("preferTemplateLiteralGuard")
            : O.none,
        );
      },
    };
  },
});
