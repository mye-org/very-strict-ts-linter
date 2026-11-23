import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { isCalleeOfCallExpression } from "../lib/call-callee.js";
import { createRule } from "../lib/rule-factory.js";

type Options = [Readonly<Record<"maxHops", number>>];
type MessageIds = "trainWreckNavigation";

const isCallCallee = isCalleeOfCallExpression;

const isOutermostPropertyChain = (node: TSESTree.MemberExpression) =>
  !isCallCallee(node) &&
  !(
    node.parent.type === AST_NODE_TYPES.MemberExpression &&
    node.parent.object === node &&
    !isCallCallee(node.parent)
  );

const isNamespaceDecl = (d: ts.Declaration) =>
  ts.isNamespaceImport(d) || ts.isModuleDeclaration(d) || ts.isEnumDeclaration(d);

const resolveExprTsSymbol = (
  expr: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
) =>
  services.program.getTypeChecker().getSymbolAtLocation(services.esTreeNodeToTSNodeMap.get(expr));

const lookupSymbolAtExpr = (
  expr: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
) => O.fromNullable(resolveExprTsSymbol(expr, services));

const hasNamespaceDeclaration = flow(
  O.flatMap((sym: ts.Symbol) => O.fromNullable(sym.declarations)),
  O.exists(RA.some(isNamespaceDecl)),
);

const isNamespaceSymbol = (
  expr: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
) => hasNamespaceDeclaration(lookupSymbolAtExpr(expr, services));

const isHopRoot = (
  expr: TSESTree.MemberExpression,
  services: ParserServicesWithTypeInformation,
) => expr.object.type === AST_NODE_TYPES.ThisExpression || isNamespaceSymbol(expr.object, services);

const countPropertyHops = (
  expr: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive hop count
): number => (expr.type === AST_NODE_TYPES.MemberExpression ? countMemberHops(expr, services) : 0);

const countMemberHops = (
  expr: TSESTree.MemberExpression,
  services: ParserServicesWithTypeInformation,
) => (isHopRoot(expr, services) ? 0 : 1 + countPropertyHops(expr.object, services));

const formatHopFields = (hops: number, maxHops: number) => ({
  hops: String(hops),
  max: String(maxHops),
});

const reportIfExceedsMaxHops = (
  node: TSESTree.MemberExpression,
  hops: number,
  maxHops: number,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(hops > maxHops)
    .with(true, () => {
      report({
        node,
        messageId: "trainWreckNavigation",
        data: formatHopFields(hops, maxHops),
      });
    })
    .with(false, () => {})
    .exhaustive();
};

const checkMemberChain = (
  node: TSESTree.MemberExpression,
  maxHops: number,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(isOutermostPropertyChain(node))
    .with(true, () => {
      reportIfExceedsMaxHops(node, countPropertyHops(node, services), maxHops, report);
    })
    .with(false, () => {})
    .exhaustive();
};

const buildTrainWreckListeners = (
  maxHops: number,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => ({
  MemberExpression: (node: TSESTree.MemberExpression) => {
    checkMemberChain(node, maxHops, services, report);
  },
});

export const noTrainWreckNavigation = createRule<Options, MessageIds>({
  name: "no-train-wreck-navigation",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce the Law of Demeter by flagging chained property navigation beyond 2 hops; prefer delegating methods, Domain Services, or ID references.",
    },
    messages: {
      trainWreckNavigation:
        "Train-wreck property chain of {{hops}} hops (max {{max}}). Introduce a delegating domain method, Domain Service, or hold an ID reference instead of navigating deep object graphs.",
    },
    schema: [
      {
        type: "object",
        properties: { maxHops: { type: "number", minimum: 1 } },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ maxHops: 2 }],
  },
  create: (context, [options]) =>
    buildTrainWreckListeners(options.maxHops, ESLintUtils.getParserServices(context), (d) => {
      context.report(d);
    }),
});
