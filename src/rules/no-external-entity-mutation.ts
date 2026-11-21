import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as R from "fp-ts/lib/Record.js";
import { flow, pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import { normalizeFilePath } from "../utils/program-cache.js";
import {
  getEstreeChildNodes,
  getTsTypeDeclarationFile,
  isEsTreeFunctionNode,
  isMemberAssignment,
  isSetterMethodName,
} from "../utils/type-helpers.js";

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

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive root unwrap
const getRootTarget = (node: TSESTree.Expression): O.Option<TSESTree.Identifier> =>
  match(node)
    .with({ type: AST_NODE_TYPES.Identifier }, O.some)
    .with({ type: AST_NODE_TYPES.MemberExpression }, (m) => getRootTarget(m.object))
    .with(P._, () => O.none as O.Option<TSESTree.Identifier>)
    .exhaustive();

const isDefinedInSameFile = (
  target: TSESTree.Expression,
  currentFile: string,
  services: ParserServicesWithTypeInformation,
) =>
  pipe(
    services.program.getTypeChecker().getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(target)),
    getTsTypeDeclarationFile,
    O.exists((declFile) => normalizeFilePath(declFile) === normalizeFilePath(currentFile)),
  );

const extractMemberUpdate = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.UpdateExpression && node.argument.type === AST_NODE_TYPES.MemberExpression
    ? [node.argument]
    : ([] as ReadonlyArray<TSESTree.MemberExpression>);

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
        ...pipe(
          getEstreeChildNodes(node, visitorKeys),
          RA.flatMap((child) => collectAssignmentsInBlock(child, visitorKeys)),
        ),
      ];

const toTargetAssignment = (m: TSESTree.MemberExpression) =>
  pipe(
    getRootTarget(m.object),
    O.map((id) => ({ targetName: id.name, targetNode: id, member: m })),
  );

const groupMutationsByTarget = (mutations: ReadonlyArray<TSESTree.MemberExpression>) =>
  pipe(
    mutations,
    RA.filterMap(toTargetAssignment),
    RA.reduce({}, (acc: Readonly<Record<string, ReadonlyArray<TargetAssignment>>>, entry) => ({
      ...acc,
      [entry.targetName]: [...(acc[entry.targetName] ?? []), entry],
    })),
  );

const reportTargetMutations = (
  targetName: string,
  items: ReadonlyArray<TargetAssignment>,
  minMutations: number,
  currentFile: string,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    O.fromNullable(items[0]),
    O.filter((first) => items.length >= minMutations && !isDefinedInSameFile(first.targetNode, currentFile, services)),
    O.map((first) => {
      report({ node: first.member, messageId: "externalMutation", data: { target: targetName, count: String(items.length) } });
    }),
  );
};

const collectBodyAssignments = (
  body: FunctionBodyNode["body"],
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
) =>
  body.type === AST_NODE_TYPES.BlockStatement
    ? pipe(body.body, RA.flatMap((s) => collectAssignmentsInBlock(s, visitorKeys)))
    : ([] as ReadonlyArray<TSESTree.MemberExpression>);

const checkFunctionMutations = (
  fn: FunctionBodyNode,
  minMutations: number,
  currentFile: string,
  visitorKeys: TSESLint.SourceCode["visitorKeys"],
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    collectBodyAssignments(fn.body, visitorKeys),
    groupMutationsByTarget,
    R.toEntries,
    RA.map(([targetName, items]) => {
      reportTargetMutations(targetName, items, minMutations, currentFile, services, report);
    }),
  );
};

const isExternalSetterMember = (
  member: TSESTree.MemberExpression,
  currentFile: string,
  services: ParserServicesWithTypeInformation,
) =>
  member.property.type === AST_NODE_TYPES.Identifier &&
  member.object.type !== AST_NODE_TYPES.ThisExpression &&
  isSetterMethodName(member.property.name) &&
  !isDefinedInSameFile(member.object, currentFile, services);

const checkSetterCall = (
  node: TSESTree.CallExpression,
  currentFile: string,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    O.some(node.callee),
    O.filter((c): c is TSESTree.MemberExpression => c.type === AST_NODE_TYPES.MemberExpression),
    O.filter((m) => isExternalSetterMember(m, currentFile, services)),
    O.map(
      flow(
        (m) => m.property,
        O.fromPredicate((p): p is TSESTree.Identifier => p.type === AST_NODE_TYPES.Identifier),
        O.map((id) => { report({ node, messageId: "setterAbuse", data: { method: id.name } }); }),
      ),
    ),
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
      checkFunctionMutations(fn, options.minMutations, context.filename, context.sourceCode.visitorKeys, services, report);
    };
    return {
      FunctionDeclaration: checkFn,
      FunctionExpression: checkFn,
      ArrowFunctionExpression: checkFn,
      CallExpression: (node) => { checkSetterCall(node, context.filename, services, report); },
    };
  },
});
