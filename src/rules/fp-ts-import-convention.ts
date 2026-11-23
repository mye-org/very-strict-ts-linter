import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "useLibPath" | "useNamespaceImport";

const FUNCTION_MODULE_RE = /^fp-ts\/(lib\/)?function(\.js)?$/;
const FP_TS_TOP_LEVEL_MODULE_RE = /^fp-ts\/([A-Z][A-Za-z0-9]*(?:\.js)?)$/;

const hasOnlyNamespaceSpecifier = (node: TSESTree.ImportDeclaration) =>
  node.specifiers.length === 1 &&
  node.specifiers[0]?.type === AST_NODE_TYPES.ImportNamespaceSpecifier;

const hasOnlyTypeSpecifiers = (node: TSESTree.ImportDeclaration) =>
  node.specifiers.length > 0 &&
  node.specifiers.every(
    (spec) =>
      spec.type === AST_NODE_TYPES.ImportSpecifier && spec.importKind === "type",
  );

const checkTopLevelPath = (
  node: TSESTree.ImportDeclaration,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => {
  pipe(
    O.fromNullable(FP_TS_TOP_LEVEL_MODULE_RE.exec(node.source.value)?.[1]),
    O.map((module) => {
      report({ node: node.source, messageId: "useLibPath", data: { module } });
    }),
  );
};

const checkNamespaceImport = (
  node: TSESTree.ImportDeclaration,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => {
  const source = node.source.value;
  match({
    isFunctionModule: FUNCTION_MODULE_RE.test(source),
    importKind: node.importKind,
    isInlineTypeOnly: hasOnlyTypeSpecifiers(node),
    hasNamespace: hasOnlyNamespaceSpecifier(node),
  })
    .with(
      { isFunctionModule: false, importKind: "value", isInlineTypeOnly: false, hasNamespace: false },
      () => {
        report({ node, messageId: "useNamespaceImport", data: { source } });
      },
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
