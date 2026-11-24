import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "noExplicitReturnType";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const EMPTY_STRINGS: ReadonlyArray<string> = [];

const extractLocalExportName = (spec: TSESTree.ExportSpecifier) =>
  spec.local.type === AST_NODE_TYPES.Identifier
    ? O.some(spec.local.name)
    : O.none;

const filterLocalExportNames = RA.filterMap(extractLocalExportName);

const extractLocalExportNames = (decl: TSESTree.ExportNamedDeclaration) =>
  decl.source ? EMPTY_STRINGS : filterLocalExportNames(decl.specifiers);

const collectExportedNames = (body: ReadonlyArray<TSESTree.ProgramStatement>) =>
  new Set(
    RA.flatMap((stmt: TSESTree.ProgramStatement) =>
      match(stmt)
        .with({ type: AST_NODE_TYPES.ExportNamedDeclaration }, extractLocalExportNames)
        .with(
          {
            type: AST_NODE_TYPES.ExportDefaultDeclaration,
            declaration: { type: AST_NODE_TYPES.Identifier },
          },
          (decl) => [decl.declaration.name],
        )
        .with(P._, () => EMPTY_STRINGS)
        .exhaustive(),
    )(body),
  );

const isExportedVariableDeclarator = (
  node: TSESTree.Node,
  exportedNames: ReadonlySet<string>,
) =>
  match(node)
    .with(
      {
        type: AST_NODE_TYPES.VariableDeclarator,
        id: { type: AST_NODE_TYPES.Identifier },
        parent: {
          type: AST_NODE_TYPES.VariableDeclaration,
          parent: { type: AST_NODE_TYPES.ExportNamedDeclaration },
        },
      },
      () => true,
    )
    .with(
      {
        type: AST_NODE_TYPES.VariableDeclarator,
        id: { type: AST_NODE_TYPES.Identifier },
        parent: {
          type: AST_NODE_TYPES.VariableDeclaration,
          parent: { type: AST_NODE_TYPES.Program },
        },
      },
      (declarator) => exportedNames.has(declarator.id.name),
    )
    .with(P._, () => false)
    .exhaustive();

const isExportedFunction = (
  node: FunctionNode,
  exportedNames: ReadonlySet<string>,
) =>
  match(node)
    .with(
      P.union(
        { parent: { type: AST_NODE_TYPES.ExportNamedDeclaration } },
        { parent: { type: AST_NODE_TYPES.ExportDefaultDeclaration } },
      ),
      () => true,
    )
    .with({ parent: { type: AST_NODE_TYPES.VariableDeclarator } }, ({ parent }) =>
      isExportedVariableDeclarator(parent, exportedNames),
    )
    .with(
      {
        type: AST_NODE_TYPES.FunctionDeclaration,
        parent: { type: AST_NODE_TYPES.Program },
      },
      flow(
        (matched: TSESTree.FunctionDeclaration) => O.fromNullable(matched.id),
        O.exists((id: TSESTree.Identifier) => exportedNames.has(id.name)),
      ),
    )
    .with(P._, () => false)
    .exhaustive();

const extractProgramBody = (sourceCode: Readonly<TSESLint.SourceCode>) =>
  sourceCode.ast.body;

const buildListeners = (
  exportedNames: ReadonlySet<string>,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  const checkFunction = (node: FunctionNode) => {
    match({
      isExported: isExportedFunction(node, exportedNames),
      returnType: node.returnType,
    })
      .with(
        {
          isExported: false,
          returnType: {
            typeAnnotation: { type: P.not(AST_NODE_TYPES.TSTypePredicate) },
          },
        },
        ({ returnType }) => {
          report({ node: returnType, messageId: "noExplicitReturnType" });
        },
      )
      .otherwise(() => {});
  };
  return {
    FunctionDeclaration: checkFunction,
    FunctionExpression: checkFunction,
    ArrowFunctionExpression: checkFunction,
  };
};

const collectBodyExportedNames = flow(extractProgramBody, collectExportedNames);

const buildRuleListeners = (
  sourceCode: Readonly<TSESLint.SourceCode>,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => buildListeners(collectBodyExportedNames(sourceCode), report);

export const noExplicitReturnType = createRule<[], MessageIds>({
  name: "no-explicit-return-type",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow explicit return type annotations on local helper functions so TypeScript infers the narrowest possible return type, while allowing them on exported functions.",
    },
    messages: {
      noExplicitReturnType:
        "Do not specify an explicit return type on local helper functions; let TypeScript infer the narrowest return type or use `satisfies`.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) =>
    buildRuleListeners(context.sourceCode, (d) => {
      context.report(d);
    }),
});
