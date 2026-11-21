import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { analyzeAggregateGraph } from "../analyzers/aggregate-graph-analyzer.js";
import { createRule } from "../utils/create-rule.js";
import { getTsTypeName, unwrapContainerTsTypes } from "../utils/type-helpers.js";

type Options = [
  Readonly<{
    readonly aggregateRoots: ReadonlyArray<string>;
    readonly aggregatePathPatterns: ReadonlyArray<string>;
  }>,
];
type MessageIds = "crossAggregateReference";

type MemberNode = TSESTree.TSPropertySignature | TSESTree.PropertyDefinition;

const filterPropSigs = (members: ReadonlyArray<TSESTree.TypeElement>) =>
  pipe(
    members,
    RA.filter((m): m is TSESTree.TSPropertySignature => m.type === AST_NODE_TYPES.TSPropertySignature),
  );

const extractTypeLiteralMembers = (typeNode: TSESTree.TypeNode) =>
  match(typeNode)
    .with({ type: AST_NODE_TYPES.TSTypeLiteral }, (lit) => filterPropSigs(lit.members))
    .with(
      {
        type: AST_NODE_TYPES.TSTypeReference,
        typeName: { type: AST_NODE_TYPES.Identifier, name: "Readonly" },
      },
      (ref) =>
        ref.typeArguments?.params[0]?.type === AST_NODE_TYPES.TSTypeLiteral
          ? filterPropSigs(ref.typeArguments.params[0].members)
          : ([] as ReadonlyArray<TSESTree.TSPropertySignature>),
    )
    .with(P._, () => [] as ReadonlyArray<TSESTree.TSPropertySignature>)
    .exhaustive();

const checkPropertyMember = (
  member: MemberNode,
  currentAggregate: string,
  aggregateRoots: ReadonlySet<string>,
  services: ParserServicesWithTypeInformation,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => {
  const checker = services.program.getTypeChecker();
  pipe(
    services.esTreeNodeToTSNodeMap.get(member),
    (tsNode) => checker.getTypeAtLocation(tsNode),
    (t) => unwrapContainerTsTypes(t, checker),
    RA.filterMap(getTsTypeName),
    RA.filter((target) => target !== currentAggregate && aggregateRoots.has(target)),
    RA.map((target) => {
      report({ node: member, messageId: "crossAggregateReference", data: { current: currentAggregate, target, idName: `${target}Id` } });
    }),
  );
};

const checkAllPropertyMembers = (
  members: ReadonlyArray<MemberNode>,
  aggName: string,
  aggregateRoots: ReadonlySet<string>,
  services: ParserServicesWithTypeInformation,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => {
  pipe(members, RA.map((m) => { checkPropertyMember(m, aggName, aggregateRoots, services, report); }));
};

const checkAggregateMembers = (
  name: O.Option<string>,
  members: ReadonlyArray<MemberNode>,
  aggregateRoots: ReadonlySet<string>,
  services: ParserServicesWithTypeInformation,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => {
  pipe(
    name,
    O.filter((aggName) => aggregateRoots.has(aggName)),
    O.map((aggName) => {
      checkAllPropertyMembers(members, aggName, aggregateRoots, services, report);
    }),
  );
};

const isPropSig = (m: TSESTree.TypeElement): m is TSESTree.TSPropertySignature =>
  m.type === AST_NODE_TYPES.TSPropertySignature;

const isClassPropDef = (m: TSESTree.ClassElement): m is TSESTree.PropertyDefinition =>
  m.type === AST_NODE_TYPES.PropertyDefinition;

const createAggregateRefListeners = (
  services: ParserServicesWithTypeInformation,
  aggregateRoots: ReadonlySet<string>,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => ({
  TSTypeAliasDeclaration: (node: TSESTree.TSTypeAliasDeclaration) => {
    checkAggregateMembers(O.some(node.id.name), extractTypeLiteralMembers(node.typeAnnotation), aggregateRoots, services, report);
  },
  TSInterfaceDeclaration: (node: TSESTree.TSInterfaceDeclaration) => {
    checkAggregateMembers(O.some(node.id.name), pipe(node.body.body, RA.filter(isPropSig)), aggregateRoots, services, report);
  },
  ClassDeclaration: (node: TSESTree.ClassDeclaration) => {
    checkAggregateMembers(O.fromNullable(node.id?.name), pipe(node.body.body, RA.filter(isClassPropDef)), aggregateRoots, services, report);
  },
});

export const noCrossAggregateReference = createRule<Options, MessageIds>({
  name: "no-cross-aggregate-reference",
  meta: {
    type: "problem",
    docs: {
      description:
        "Prevent an Aggregate Root from holding a direct reference to another Aggregate Root; require `*Id` Value Objects instead.",
    },
    messages: {
      crossAggregateReference:
        "Aggregate Root `{{current}}` directly references Aggregate Root `{{target}}`. Reference `{{idName}}` instead.",
    },
    schema: [
      {
        type: "object",
        properties: {
          aggregateRoots: { type: "array", items: { type: "string" } },
          aggregatePathPatterns: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        aggregateRoots: [],
        aggregatePathPatterns: ["**/aggregates/**", "**/aggregate/**"],
      },
    ],
  },
  create: (context, [options]) => {
    const services = ESLintUtils.getParserServices(context);
    return createAggregateRefListeners(
      services,
      analyzeAggregateGraph(services.program, options.aggregateRoots, options.aggregatePathPatterns).aggregateRoots,
      (d) => { context.report(d); },
    );
  },
});
