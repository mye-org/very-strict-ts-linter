import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../lib/rule-factory.js";
import { isOptionTsType } from "../lib/ts-option-type.js";

const OPTION_REF_NAMES: ReadonlySet<string> = new Set(["Option"]);
const NULLABLE_TS_FLAGS = ts.TypeFlags.Null | ts.TypeFlags.Undefined;

const isBooleanTsType = (type: ts.Type) =>
  (type.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !== 0 ||
  (type.isUnion() &&
    type.types.length > 0 &&
    RA.every((m: ts.Type) => (m.flags & ts.TypeFlags.BooleanLiteral) !== 0)(type.types));

const isOptionTypeRefName = (typeName: TSESTree.EntityName) =>
  match(typeName)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => OPTION_REF_NAMES.has(id.name))
    .with({ type: AST_NODE_TYPES.TSQualifiedName }, (q) => OPTION_REF_NAMES.has(q.right.name))
    .with(P._, () => false)
    .exhaustive();

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive union type walk
const isNullableOrOptionTypeNode = (typeNode: TSESTree.TypeNode): boolean =>
  match(typeNode)
    .with({ type: AST_NODE_TYPES.TSNullKeyword }, { type: AST_NODE_TYPES.TSUndefinedKeyword }, () => true)
    .with({ type: AST_NODE_TYPES.TSTypeReference }, (ref) => isOptionTypeRefName(ref.typeName))
    .with({ type: AST_NODE_TYPES.TSUnionType }, (u) => RA.some(isNullableOrOptionTypeNode)(u.types))
    .with(P._, () => false)
    .exhaustive();

const isNullableOrOptionTsType = (type: ts.Type) =>
  isOptionTsType(type) ||
  (type.isUnion() && RA.some((m: ts.Type) => (m.flags & NULLABLE_TS_FLAGS) !== 0)(type.types));

type Options = [Readonly<Record<"minBooleans" | "minNullableTimestamps", number>>];
type MessageIds = "booleanFlagCluster" | "nullableTimestampCluster";

type PropertyMember = TSESTree.TSPropertySignature | TSESTree.PropertyDefinition;

const TIMESTAMP_SUFFIXES = ["At", "Date", "On", "Timestamp"];

const hasTimestampSuffix = (name: string) =>
  RA.some((s: string) => name.endsWith(s))(TIMESTAMP_SUFFIXES);

const extractMemberName = (member: PropertyMember) =>
  member.key.type === AST_NODE_TYPES.Identifier ? O.some(member.key.name) : O.none;

const resolveAnnotationTypeNode = flow(
  (member: PropertyMember) => member.typeAnnotation,
  O.fromNullable,
  O.map((ann) => ann.typeAnnotation),
);

const resolveMemberTsType = (
  member: PropertyMember,
  services: ParserServicesWithTypeInformation,
) =>
  services.program.getTypeChecker().getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(member));

const isBooleanProperty = (
  member: PropertyMember,
  services: ParserServicesWithTypeInformation,
) =>
  O.exists((t: TSESTree.TypeNode) => t.type === AST_NODE_TYPES.TSBooleanKeyword)(
    resolveAnnotationTypeNode(member),
  ) || isBooleanTsType(resolveMemberTsType(member, services));

const isNullableTimestampProperty = (
  member: PropertyMember,
  services: ParserServicesWithTypeInformation,
) =>
  O.exists(hasTimestampSuffix)(extractMemberName(member)) &&
  (member.optional ||
    O.exists(isNullableOrOptionTypeNode)(resolveAnnotationTypeNode(member)) ||
    isNullableOrOptionTsType(resolveMemberTsType(member, services)));

const isPropertyMember = (
  m: TSESTree.TypeElement | TSESTree.ClassElement,
): m is PropertyMember =>
  m.type === AST_NODE_TYPES.TSPropertySignature ||
  m.type === AST_NODE_TYPES.PropertyDefinition;

const extractPropertyMembers = RA.filter(isPropertyMember);

const formatClusterPayload = (fields: ReadonlyArray<string>) => ({
  count: String(fields.length),
  fields: fields.join(", "),
});

const reportCluster = (
  reportNode: TSESTree.Node,
  fields: ReadonlyArray<string>,
  threshold: number,
  messageId: MessageIds,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(fields.length >= threshold)
    .with(true, () => {
      report({ node: reportNode, messageId, data: formatClusterPayload(fields) });
    })
    .with(false, () => {})
    .exhaustive();
};

const collectMatchingMemberNames = (
  members: ReadonlyArray<PropertyMember>,
  predicate: (m: PropertyMember) => boolean,
) =>
  RA.filterMap((m: PropertyMember) => (predicate(m) ? extractMemberName(m) : O.none))(members);

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

const buildLifecycleListeners = (
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
    buildLifecycleListeners(options, ESLintUtils.getParserServices(context), (d) => { context.report(d); }),
});
