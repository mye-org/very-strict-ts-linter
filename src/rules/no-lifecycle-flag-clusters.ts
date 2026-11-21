import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import { isBooleanTsType, isNullableOrOptionTsType, isNullableOrOptionTypeNode } from "../utils/type-helpers.js";

type Options = [Readonly<Record<"minBooleans" | "minNullableTimestamps", number>>];
type MessageIds = "booleanFlagCluster" | "nullableTimestampCluster";

type PropertyMember = TSESTree.TSPropertySignature | TSESTree.PropertyDefinition;

const TIMESTAMP_SUFFIXES = ["At", "Date", "On", "Timestamp"];

const hasTimestampSuffix = (name: string) =>
  pipe(TIMESTAMP_SUFFIXES, RA.some((s) => name.endsWith(s)));

const getMemberName = (member: PropertyMember) =>
  member.key.type === AST_NODE_TYPES.Identifier ? O.some(member.key.name) : O.none;

const getMemberTsType = (
  member: PropertyMember,
  services: ParserServicesWithTypeInformation,
) =>
  pipe(
    services.esTreeNodeToTSNodeMap.get(member),
    (tsNode) => services.program.getTypeChecker().getTypeAtLocation(tsNode),
  );

const isBooleanProperty = (
  member: PropertyMember,
  services: ParserServicesWithTypeInformation,
) =>
  member.typeAnnotation?.typeAnnotation.type === AST_NODE_TYPES.TSBooleanKeyword ||
  isBooleanTsType(getMemberTsType(member, services));

const isNullableTimestampProperty = (
  member: PropertyMember,
  services: ParserServicesWithTypeInformation,
) =>
  pipe(getMemberName(member), O.exists(hasTimestampSuffix)) &&
  (member.optional ||
    pipe(O.fromNullable(member.typeAnnotation?.typeAnnotation), O.exists(isNullableOrOptionTypeNode)) ||
    isNullableOrOptionTsType(getMemberTsType(member, services)));

const extractPropertyMembers = (
  members: ReadonlyArray<TSESTree.TypeElement | TSESTree.ClassElement>,
) =>
  pipe(
    members,
    RA.filter(
      (m): m is PropertyMember =>
        m.type === AST_NODE_TYPES.TSPropertySignature ||
        m.type === AST_NODE_TYPES.PropertyDefinition,
    ),
  );

const reportCluster = (
  reportNode: TSESTree.Node,
  fields: ReadonlyArray<string>,
  threshold: number,
  messageId: MessageIds,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(fields.length >= threshold)
    .with(true, () => {
      report({ node: reportNode, messageId, data: { count: String(fields.length), fields: fields.join(", ") } });
    })
    .with(false, () => {})
    .exhaustive();
};

const collectMatchingMemberNames = (
  members: ReadonlyArray<PropertyMember>,
  predicate: (m: PropertyMember) => boolean,
) => pipe(members, RA.filter(predicate), RA.filterMap(getMemberName));

const reportClusterFor = (
  reportNode: TSESTree.Node,
  members: ReadonlyArray<PropertyMember>,
  threshold: number,
  messageId: MessageIds,
  predicate: (m: PropertyMember) => boolean,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  reportCluster(reportNode, collectMatchingMemberNames(members, predicate), threshold, messageId, report);
};

const checkMembers = (
  reportNode: TSESTree.Node,
  members: ReadonlyArray<PropertyMember>,
  options: Options[0],
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  reportClusterFor(reportNode, members, options.minBooleans, "booleanFlagCluster", (m) => isBooleanProperty(m, services), report);
  reportClusterFor(reportNode, members, options.minNullableTimestamps, "nullableTimestampCluster", (m) => isNullableTimestampProperty(m, services), report);
};

const createLifecycleListeners = (
  options: Options[0],
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  const run = (node: TSESTree.Node, raw: ReadonlyArray<TSESTree.TypeElement | TSESTree.ClassElement>) => {
    checkMembers(node, extractPropertyMembers(raw), options, services, report);
  };
  return {
    TSTypeLiteral: (node: TSESTree.TSTypeLiteral) => { run(node, node.members); },
    TSInterfaceBody: (node: TSESTree.TSInterfaceBody) => { run(node, node.body); },
    ClassBody: (node: TSESTree.ClassBody) => { run(node, node.body); },
  };
};

export const noLifecycleFlagClusters = createRule<Options, MessageIds>({
  name: "no-lifecycle-flag-clusters",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag domain types or classes with clusters of 3+ lifecycle booleans or nullable/Option timestamps; refactor into an explicit State Machine or Discriminated Union.",
    },
    messages: {
      booleanFlagCluster:
        "Model has {{count}} boolean flags ({{fields}}). Refactor into an explicit Discriminated Union or State Machine.",
      nullableTimestampCluster:
        "Model has {{count}} nullable/Option lifecycle timestamps ({{fields}}). Refactor into explicit state variants (e.g. `DraftOrder | PaidOrder | CancelledOrder`).",
    },
    schema: [
      {
        type: "object",
        properties: {
          minBooleans: { type: "number", minimum: 2 },
          minNullableTimestamps: { type: "number", minimum: 2 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ minBooleans: 3, minNullableTimestamps: 3 }],
  },
  create: (context, [options]) =>
    createLifecycleListeners(options, ESLintUtils.getParserServices(context), (d) => { context.report(d); }),
});
