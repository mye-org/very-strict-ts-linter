import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as R from "fp-ts/lib/Record.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import type * as ts from "typescript";
import { collectEstreeChildNodes } from "../lib/estree-children.js";
import { isEsTreeFunctionNode } from "../lib/estree-function-nodes.js";
import { isMemberAssignment } from "../lib/member-assignment.js";
import { createRule } from "../lib/rule-factory.js";
import { isSetterMethodName } from "../lib/setter-method.js";
import { normalizeFilePath } from "../lib/source-paths.js";
import { resolveTsTypeDeclarationFile } from "../lib/ts-type-declaration.js";

type Options = [Readonly<Record<"minMutations", number>>];
type MessageIds = "externalMutation" | "setterAbuse";

type FunctionBodyNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

type TargetAssignment = Readonly<{
  readonly targetNode: TSESTree.Identifier;
  readonly member: TSESTree.MemberExpression;
}>;

const NONE_IDENTIFIER: O.Option<TSESTree.Identifier> = O.none;
const EMPTY_MEMBER_EXPRS: ReadonlyArray<TSESTree.MemberExpression> = [];

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive root unwrap
const resolveRootTarget = (node: TSESTree.Expression): O.Option<TSESTree.Identifier> =>
  match(node)
    .with({ type: AST_NODE_TYPES.Identifier }, O.some)
    .with({ type: AST_NODE_TYPES.MemberExpression }, (m) => resolveRootTarget(m.object))
    .with(P._, () => NONE_IDENTIFIER)
    .exhaustive();

const isProjectSourcePath = (norm: string) =>
  !norm.includes("/node_modules/") && !norm.endsWith(".d.ts");

const isExternalProjectFile = (declFile: string, currentFile: string) => {
  const norm = normalizeFilePath(declFile);
  return norm !== normalizeFilePath(currentFile) && isProjectSourcePath(norm);
};

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive intersection check
const isExternalProjectTsType = (type: ts.Type, currentFile: string): boolean =>
  O.exists((declFile: string) => isExternalProjectFile(declFile, currentFile))(
    resolveTsTypeDeclarationFile(type),
  ) ||
  (type.isIntersection() &&
    RA.some((member: ts.Type) => isExternalProjectTsType(member, currentFile))(type.types));

const resolveExpressionTsType = (
  target: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
) =>
  services.program.getTypeChecker().getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(target));

const isExternalProjectEntityType = (
  target: TSESTree.Expression,
  currentFile: string,
  services: ParserServicesWithTypeInformation,
) => isExternalProjectTsType(resolveExpressionTsType(target, services), currentFile);

const extractMemberUpdate = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.UpdateExpression && node.argument.type === AST_NODE_TYPES.MemberExpression
    ? [node.argument]
    : EMPTY_MEMBER_EXPRS;

const extractDirectMemberAssignment = (node: TSESTree.Node) =>
  isMemberAssignment(node) ? [node.left] : extractMemberUpdate(node);

const collectAssignmentsInBlock = (
  node: TSESTree.Node,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST scan
): ReadonlyArray<TSESTree.MemberExpression> =>
  isEsTreeFunctionNode(node)
    ? []
    : [
        ...extractDirectMemberAssignment(node),
        ...RA.flatMap((child: TSESTree.Node) => collectAssignmentsInBlock(child, visitorKeys))(
          collectEstreeChildNodes(node, visitorKeys),
        ),
      ];

const toTargetAssignment = (m: TSESTree.MemberExpression) =>
  match(resolveRootTarget(m.object))
    .with({ _tag: "Some" }, ({ value }) =>
      O.some({ targetName: value.name, targetNode: value, member: m }),
    )
    .with({ _tag: "None" }, () => O.none)
    .exhaustive();

const groupMutationsByTarget = flow(
  RA.filterMap(toTargetAssignment),
  RA.reduce({}, (acc: Readonly<Record<string, ReadonlyArray<TargetAssignment>>>, entry) => ({
    ...acc,
    [entry.targetName]: [...(acc[entry.targetName] ?? []), entry],
  })),
);

const groupMutationEntries = flow(groupMutationsByTarget, R.toEntries);

const formatExternalMutationPayload = (target: string, count: number) => ({
  target,
  count: String(count),
});

const filterExternalTarget = (
  items: ReadonlyArray<TargetAssignment>,
  minMutations: number,
  currentFile: string,
  services: ParserServicesWithTypeInformation,
) =>
  O.filter(
    (first: TargetAssignment) =>
      items.length >= minMutations &&
      isExternalProjectEntityType(first.targetNode, currentFile, services),
  )(RA.head<TargetAssignment>(items));

const reportTargetMutations = (
  targetName: string,
  items: ReadonlyArray<TargetAssignment>,
  minMutations: number,
  currentFile: string,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  O.map((first: TargetAssignment) => {
    report({
      node: first.member,
      messageId: "externalMutation",
      data: formatExternalMutationPayload(targetName, items.length),
    });
  })(filterExternalTarget(items, minMutations, currentFile, services));
};

const collectBodyAssignments = (
  body: FunctionBodyNode["body"],
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) =>
  body.type === AST_NODE_TYPES.BlockStatement
    ? RA.flatMap((s: TSESTree.Statement) => collectAssignmentsInBlock(s, visitorKeys))(body.body)
    : EMPTY_MEMBER_EXPRS;

const collectBodyMutationEntries = (
  body: FunctionBodyNode["body"],
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) => groupMutationEntries(collectBodyAssignments(body, visitorKeys));

const checkFunctionMutations = (
  fn: FunctionBodyNode,
  options: Options[0],
  currentFile: string,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  RA.map(([targetName, items]: readonly [string, ReadonlyArray<TargetAssignment>]) => {
    reportTargetMutations(targetName, items, options.minMutations, currentFile, services, report);
  })(collectBodyMutationEntries(fn.body, visitorKeys));
};

const isExternalSetterMember = (
  member: TSESTree.MemberExpression,
  currentFile: string,
  services: ParserServicesWithTypeInformation,
) =>
  !member.computed &&
  member.property.type === AST_NODE_TYPES.Identifier &&
  member.object.type !== AST_NODE_TYPES.ThisExpression &&
  isSetterMethodName(member.property.name) &&
  isExternalProjectEntityType(member.object, currentFile, services);

const extractSetterMethodName = (member: TSESTree.MemberExpression) =>
  member.property.type === AST_NODE_TYPES.Identifier ? O.some(member.property.name) : O.none;

const extractMemberCallee = O.fromPredicate(
  (c: TSESTree.Expression): c is TSESTree.MemberExpression => c.type === AST_NODE_TYPES.MemberExpression,
);

const checkSetterCall = (
  node: TSESTree.CallExpression,
  currentFile: string,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  const resolveSetterName = flow(
    extractMemberCallee,
    O.filter((m: TSESTree.MemberExpression) => isExternalSetterMember(m, currentFile, services)),
    O.flatMap(extractSetterMethodName),
  );
  O.map((method: string) => { report({ node, messageId: "setterAbuse", data: { method } }); })(
    resolveSetterName(node.callee),
  );
};

export const noExternalEntityMutation = createRule<Options, MessageIds>({
  name: "no-external-entity-mutation",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag external code that mutates multiple entity properties directly or invokes public `set*` setters; prefer intention-revealing domain methods.",
    },
    messages: {
      externalMutation:
        "External mutation of {{count}} properties on `{{target}}`. Encapsulate state transitions in an intention-revealing domain method or transition function.",
      setterAbuse:
        "Avoid external setter call `{{method}}(...)`. Replace imperative setters with intention-revealing domain behavior.",
    },
    schema: [
      {
        type: "object",
        properties: { minMutations: { type: "number", minimum: 2 } },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ minMutations: 2 }],
  },
  create: (context, [options]) => {
    const services = ESLintUtils.getParserServices(context);
    const report = (d: TSESLint.ReportDescriptor<MessageIds>) => { context.report(d); };
    const checkFn = (fn: FunctionBodyNode) => {
      checkFunctionMutations(fn, options, context.filename, context.sourceCode.visitorKeys, services, report);
    };
    return {
      FunctionDeclaration: checkFn,
      FunctionExpression: checkFn,
      ArrowFunctionExpression: checkFn,
      CallExpression: (node) => { checkSetterCall(node, context.filename, services, report); },
    };
  },
});
