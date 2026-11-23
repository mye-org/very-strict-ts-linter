import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "useLibPath" | "useNamespaceImport";

const FUNCTION_MODULE_RE = /^fp-ts\/(lib\/)?function(\.js)?$/;
const FP_TS_TOP_LEVEL_MODULE_RE = /^fp-ts\/([A-Z][A-Za-z0-9]*(?:\.js)?)$/;

const isNamespaceSpecifier = (spec: TSESTree.ImportClause) =>
  spec.type === AST_NODE_TYPES.ImportNamespaceSpecifier;

const isTypeImportSpecifier = (spec: TSESTree.ImportClause) =>
  spec.type === AST_NODE_TYPES.ImportSpecifier && spec.importKind === "type";

const isFunctionModulePath = (source: string) => FUNCTION_MODULE_RE.test(source);

const extractTopLevelModule = (source: string) =>
  FP_TS_TOP_LEVEL_MODULE_RE.exec(source)?.[1];

const resolveTopLevelModule = flow(extractTopLevelModule, O.fromNullable);

const hasOnlyNamespaceSpecifier = (node: TSESTree.ImportDeclaration) =>
  node.specifiers.length === 1 &&
  O.exists(isNamespaceSpecifier)(RA.head<TSESTree.ImportClause>(node.specifiers));

const hasOnlyTypeSpecifiers = (node: TSESTree.ImportDeclaration) =>
  node.specifiers.length > 0 && RA.every(isTypeImportSpecifier)(node.specifiers);

const checkTopLevelPath = (
  node: TSESTree.ImportDeclaration,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => {
  O.map((module: string) => {
    report({ node: node.source, messageId: "useLibPath", data: { module } });
  })(resolveTopLevelModule(node.source.value));
};

const checkNamespaceImport = (
  node: TSESTree.ImportDeclaration,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => {
  const source = node.source.value;
  match({
    isFunctionModule: isFunctionModulePath(source),
    importKind: node.importKind,
    isInlineTypeOnly: hasOnlyTypeSpecifiers(node),
    hasNamespace: hasOnlyNamespaceSpecifier(node),
  })
    .with(
      { isFunctionModule: false, importKind: "value", isInlineTypeOnly: false, hasNamespace: false },
      () => { report({ node, messageId: "useNamespaceImport", data: { source } }); },
    )
    .otherwise(() => {});
};

export const fpTsImportConvention = createRule<[], MessageIds>({
  name: "fp-ts-import-convention",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce `import * as X from \"fp-ts/lib/...\"` namespace imports for fp-ts data modules.",
    },
    messages: {
      useLibPath:
        "Import from `fp-ts/lib/{{module}}` instead of `fp-ts/{{module}}`.",
      useNamespaceImport:
        "Use a namespace import (`import * as X from \"{{source}}\"`) for fp-ts data modules.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    ImportDeclaration: (node) => {
      match(node.source.value.startsWith("fp-ts/"))
        .with(true, () => {
          checkTopLevelPath(node, (d) => { context.report(d); });
          checkNamespaceImport(node, (d) => { context.report(d); });
        })
        .with(false, () => {})
        .exhaustive();
    },
  }),
});
