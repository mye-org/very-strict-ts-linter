import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { analyzeAggregateGraph } from "../analyzers/aggregate-graph-analyzer.js";
import { createRule } from "../lib/rule-factory.js";
import { unwrapContainerTsTypes } from "../lib/ts-container-types.js";
import { resolveTsTypeName } from "../lib/ts-type-name.js";

type Options = [
  Readonly<{
    readonly aggregateRoots: ReadonlyArray<string>;
    readonly aggregatePathPatterns: ReadonlyArray<string>;
  }>,
];
type MessageIds = "crossAggregateReference";

type MemberNode = TSESTree.TSPropertySignature | TSESTree.PropertyDefinition;
type ReportFn = (d: TSESLint.ReportDescriptor<MessageIds>) => void;

const EMPTY_PROP_SIGS: ReadonlyArray<TSESTree.TSPropertySignature> = [];

const isPropSig = (m: TSESTree.TypeElement): m is TSESTree.TSPropertySignature =>
  m.type === AST_NODE_TYPES.TSPropertySignature;

const isClassPropDef = (m: TSESTree.ClassElement): m is TSESTree.PropertyDefinition =>
  m.type === AST_NODE_TYPES.PropertyDefinition;

const filterPropSigs = RA.filter(isPropSig);

const extractFirstTypeArg = flow(
  (ref: TSESTree.TSTypeReference) => ref.typeArguments,
  O.fromNullable,
  O.flatMap((args) => RA.head(args.params)),
);

const extractLiteralPropSigs = (typeNode: TSESTree.TypeNode) =>
  typeNode.type === AST_NODE_TYPES.TSTypeLiteral
    ? filterPropSigs(typeNode.members)
    : EMPTY_PROP_SIGS;

const extractReadonlyMembers = flow(
  extractFirstTypeArg,
  O.match(() => EMPTY_PROP_SIGS, extractLiteralPropSigs),
);

const extractTypeLiteralMembers = (typeNode: TSESTree.TypeNode) =>
  match(typeNode)
    .with({ type: AST_NODE_TYPES.TSTypeLiteral }, (lit) => filterPropSigs(lit.members))
    .with(
      {
        type: AST_NODE_TYPES.TSTypeReference,
        typeName: { type: AST_NODE_TYPES.Identifier, name: "Readonly" },
      },
      extractReadonlyMembers,
    )
    .with(P._, () => EMPTY_PROP_SIGS)
    .exhaustive();

const formatAggregateRefPayload = (current: string, target: string) => ({
  current,
  target,
  idName: `${target}Id`,
});

const reportTargetIfCrossAggregate = (
  member: MemberNode,
  currentAggregate: string,
  aggregateRoots: ReadonlySet<string>,
  report: ReportFn,
) =>
  flow(
    resolveTsTypeName,
    O.filter((target) => target !== currentAggregate && aggregateRoots.has(target)),
    O.map((target) => {
      report({
        node: member,
        messageId: "crossAggregateReference",
        data: formatAggregateRefPayload(currentAggregate, target),
      });
    }),
  );

const resolveMemberTsType = (
  member: MemberNode,
  services: ParserServicesWithTypeInformation,
) =>
  services.program.getTypeChecker().getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(member));

const resolveMemberContainerTypes = (
  member: MemberNode,
  services: ParserServicesWithTypeInformation,
) => unwrapContainerTsTypes(resolveMemberTsType(member, services), services.program.getTypeChecker());

const checkPropertyMember = (
  member: MemberNode,
  currentAggregate: string,
  aggregateRoots: ReadonlySet<string>,
  services: ParserServicesWithTypeInformation,
  report: ReportFn,
) => {
  RA.map(reportTargetIfCrossAggregate(member, currentAggregate, aggregateRoots, report))(
    resolveMemberContainerTypes(member, services),
  );
};

const checkAllPropertyMembers = (
  members: ReadonlyArray<MemberNode>,
  aggName: string,
  aggregateRoots: ReadonlySet<string>,
  services: ParserServicesWithTypeInformation,
  report: ReportFn,
) => {
  RA.map((m: MemberNode) => {
    checkPropertyMember(m, aggName, aggregateRoots, services, report);
  })(members);
};

const checkAggregateMembers = (
  name: O.Option<string>,
  members: ReadonlyArray<MemberNode>,
  aggregateRoots: ReadonlySet<string>,
  services: ParserServicesWithTypeInformation,
  report: ReportFn,
) => {
  O.map((aggName: string) => {
    checkAllPropertyMembers(members, aggName, aggregateRoots, services, report);
  })(O.filter((aggName: string) => aggregateRoots.has(aggName))(name));
};

const buildAggregateRefListeners = (
  services: ParserServicesWithTypeInformation,
  aggregateRoots: ReadonlySet<string>,
  report: ReportFn,
) => ({
  TSTypeAliasDeclaration: (node: TSESTree.TSTypeAliasDeclaration) => {
    checkAggregateMembers(O.some(node.id.name), extractTypeLiteralMembers(node.typeAnnotation), aggregateRoots, services, report);
  },
  TSInterfaceDeclaration: (node: TSESTree.TSInterfaceDeclaration) => {
    checkAggregateMembers(O.some(node.id.name), RA.filter(isPropSig)(node.body.body), aggregateRoots, services, report);
  },
  ClassDeclaration: (node: TSESTree.ClassDeclaration) => {
    checkAggregateMembers(O.fromNullable(node.id?.name), RA.filter(isClassPropDef)(node.body.body), aggregateRoots, services, report);
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
    return buildAggregateRefListeners(
      services,
      analyzeAggregateGraph(services.program, options.aggregateRoots, options.aggregatePathPatterns).aggregateRoots,
      (d) => { context.report(d); },
    );
  },
});
