import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
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

type EntityMutationEnv = Readonly<{
  readonly sourceFile: ts.SourceFile;
  readonly services: ParserServicesWithTypeInformation;
  readonly options: Options[0];
  readonly visitorKeys: TSESLint.SourceCode["visitorKeys"];
  readonly report: (d: TSESLint.ReportDescriptor<MessageIds>) => void;
}>;

const resolveExpressionTsType = (
  target: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
) =>
  services.program.getTypeChecker().getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(target));

const isExternalExpr = (expr: TSESTree.Expression, env: EntityMutationEnv) =>
  isExternalProjectTsType(resolveExpressionTsType(expr, env.services), env.sourceFile.fileName);

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

const EMPTY_TARGET_ASSIGNMENTS: ReadonlyArray<TargetAssignment> = [];

const groupMutationsByTarget = flow(
  RA.filterMap(toTargetAssignment),
  RA.reduce({}, (acc: Readonly<Record<string, ReadonlyArray<TargetAssignment>>>, entry) => ({
    ...acc,
    [entry.targetName]: [
      ...O.getOrElse(() => EMPTY_TARGET_ASSIGNMENTS)(RR.lookup(entry.targetName)(acc)),
      entry,
    ],
  })),
);

const groupMutationEntries = flow(groupMutationsByTarget, R.toEntries);

const formatExternalMutationPayload = (target: string, count: number) => ({
  target,
  count: String(count),
});

const filterExternalTarget = (env: EntityMutationEnv) =>
  flow(
    O.fromPredicate((items: ReadonlyArray<TargetAssignment>) => items.length >= env.options.minMutations),
    O.flatMap(RA.head<TargetAssignment>),
    O.filter((first: TargetAssignment) => isExternalExpr(first.targetNode, env)),
  );

const reportTargetMutations = (env: EntityMutationEnv) => (
  targetName: string,
  items: ReadonlyArray<TargetAssignment>,
) => {
  O.map((first: TargetAssignment) => {
    env.report({
      node: first.member,
      messageId: "externalMutation",
      data: formatExternalMutationPayload(targetName, items.length),
    });
  })(filterExternalTarget(env)(items));
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

const checkFunctionMutations = (env: EntityMutationEnv) => (fn: FunctionBodyNode) => {
  RA.map(([targetName, items]: readonly [string, ReadonlyArray<TargetAssignment>]) => {
    reportTargetMutations(env)(targetName, items);
  })(collectBodyMutationEntries(fn.body, env.visitorKeys));
};

const isSetterMemberCall = (member: TSESTree.MemberExpression) =>
  !member.computed &&
  member.property.type === AST_NODE_TYPES.Identifier &&
  member.object.type !== AST_NODE_TYPES.ThisExpression &&
  isSetterMethodName(member.property.name);

const extractSetterMethodName = (member: TSESTree.MemberExpression) =>
  member.property.type === AST_NODE_TYPES.Identifier ? O.some(member.property.name) : O.none;

const extractMemberCallee = O.fromPredicate(
  (c: TSESTree.Expression): c is TSESTree.MemberExpression => c.type === AST_NODE_TYPES.MemberExpression,
);

const checkSetterCall = (env: EntityMutationEnv) => (node: TSESTree.CallExpression) => {
  const resolveSetterName = flow(
    extractMemberCallee,
    O.filter(isSetterMemberCall),
    O.filter((m: TSESTree.MemberExpression) => isExternalExpr(m.object, env)),
    O.flatMap(extractSetterMethodName),
  );
  O.map((method: string) => { env.report({ node, messageId: "setterAbuse", data: { method } }); })(
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
    const env: EntityMutationEnv = {
      sourceFile: services.esTreeNodeToTSNodeMap.get(context.sourceCode.ast).getSourceFile(),
      services,
      options,
      visitorKeys: context.sourceCode.visitorKeys,
      report: (d: TSESLint.ReportDescriptor<MessageIds>) => { context.report(d); },
    };
    const checkFn = checkFunctionMutations(env);
    return {
      FunctionDeclaration: checkFn,
      FunctionExpression: checkFn,
      ArrowFunctionExpression: checkFn,
      CallExpression: checkSetterCall(env),
    };
  },
});
