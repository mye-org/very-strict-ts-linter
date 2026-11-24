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

type AggregateCheckEnv = Readonly<{
  readonly services: ParserServicesWithTypeInformation;
  readonly aggregateRoots: ReadonlySet<string>;
  readonly report: ReportFn;
}>;

const reportTargetIfCrossAggregate = (
  env: AggregateCheckEnv,
) => (
  member: MemberNode,
  currentAggregate: string,
) =>
  flow(
    resolveTsTypeName,
    O.filter((target) => target !== currentAggregate && env.aggregateRoots.has(target)),
    O.map((target) => {
      env.report({
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
) => unwrapContainerTsTypes(services.program.getTypeChecker())(resolveMemberTsType(member, services));

const checkPropertyMember = (
  env: AggregateCheckEnv,
) => (
  member: MemberNode,
  currentAggregate: string,
) => {
  RA.map(reportTargetIfCrossAggregate(env)(member, currentAggregate))(
    resolveMemberContainerTypes(member, env.services),
  );
};

const checkAllPropertyMembers = (
  env: AggregateCheckEnv,
) => (
  members: ReadonlyArray<MemberNode>,
  aggName: string,
) => {
  RA.map((m: MemberNode) => {
    checkPropertyMember(env)(m, aggName);
  })(members);
};

const checkAggregateMembers = (
  env: AggregateCheckEnv,
) => (
  name: O.Option<string>,
  members: ReadonlyArray<MemberNode>,
) => {
  O.map((aggName: string) => {
    checkAllPropertyMembers(env)(members, aggName);
  })(O.filter((aggName: string) => env.aggregateRoots.has(aggName))(name));
};

const resolveClassAggregateName = flow(
  (node: TSESTree.ClassDeclaration) => node.id,
  O.fromNullable,
  O.map((id) => id.name),
);

const buildAggregateRefListeners = (
  env: AggregateCheckEnv,
) => ({
  TSTypeAliasDeclaration: (node: TSESTree.TSTypeAliasDeclaration) => {
    checkAggregateMembers(env)(O.some(node.id.name), extractTypeLiteralMembers(node.typeAnnotation));
  },
  TSInterfaceDeclaration: (node: TSESTree.TSInterfaceDeclaration) => {
    checkAggregateMembers(env)(O.some(node.id.name), RA.filter(isPropSig)(node.body.body));
  },
  ClassDeclaration: (node: TSESTree.ClassDeclaration) => {
    checkAggregateMembers(env)(resolveClassAggregateName(node), RA.filter(isClassPropDef)(node.body.body));
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
    return buildAggregateRefListeners({
      services,
      aggregateRoots: analyzeAggregateGraph(services.program, {
        explicitOptionRoots: options.aggregateRoots,
        aggregatePathPatterns: options.aggregatePathPatterns,
      }).aggregateRoots,
      report: (d) => { context.report(d); },
    });
  },
});
