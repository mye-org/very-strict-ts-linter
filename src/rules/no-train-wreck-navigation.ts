import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow, pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { createRule } from "../utils/create-rule.js";

type Options = [Readonly<Record<"maxHops", number>>];
type MessageIds = "trainWreckNavigation";

const isCallCallee = (node: TSESTree.MemberExpression) =>
  node.parent.type === AST_NODE_TYPES.CallExpression && node.parent.callee === node;

const isOutermostPropertyChain = (node: TSESTree.MemberExpression) =>
  !isCallCallee(node) &&
  !(
    node.parent.type === AST_NODE_TYPES.MemberExpression &&
    node.parent.object === node &&
    !isCallCallee(node.parent)
  );

const isNamespaceDecl = (d: ts.Declaration) =>
  ts.isNamespaceImport(d) || ts.isModuleDeclaration(d) || ts.isEnumDeclaration(d);

const isNamespaceSymbol = (
  expr: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
) =>
  pipe(
    services.esTreeNodeToTSNodeMap.get(expr),
    (tsNode) => services.program.getTypeChecker().getSymbolAtLocation(tsNode),
    O.fromNullable,
    O.flatMap((sym) => O.fromNullable(sym.declarations)),
    O.exists(RA.some(isNamespaceDecl)),
  );

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
) => (isHopRoot(expr, services) ? 1 : 1 + countPropertyHops(expr.object, services));

const checkMemberChain = (
  node: TSESTree.MemberExpression,
  maxHops: number,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    O.some(node),
    O.filter(isOutermostPropertyChain),
    O.map(flow((n) => countPropertyHops(n, services))),
    O.filter((h) => h > maxHops),
    O.map((h) => {
      report({
        node,
        messageId: "trainWreckNavigation",
        data: { hops: String(h), max: String(maxHops) },
      });
    }),
  );
};

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
  create: (context, [options]) => ({
    MemberExpression: (node) => {
      checkMemberChain(
        node,
        options.maxHops,
        ESLintUtils.getParserServices(context),
        (d) => { context.report(d); },
      );
    },
  }),
});
