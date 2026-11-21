import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "useLibPath" | "useNamespaceImport";

const FUNCTION_MODULE_RE = /^fp-ts\/(lib\/)?function(\.js)?$/;
const FP_TS_TOP_LEVEL_MODULE_RE = /^fp-ts\/([A-Z][A-Za-z0-9]*)$/;

const hasOnlyNamespaceSpecifier = (node: TSESTree.ImportDeclaration) =>
  node.specifiers.length === 1 &&
  node.specifiers[0]?.type === AST_NODE_TYPES.ImportNamespaceSpecifier;

const checkTopLevelPath = (
  node: TSESTree.ImportDeclaration,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => {
  const topLevelMatch = FP_TS_TOP_LEVEL_MODULE_RE.exec(node.source.value);
  if (topLevelMatch?.[1]) {
    report({ node: node.source, messageId: "useLibPath", data: { module: topLevelMatch[1] } });
  }
};

const checkNamespaceImport = (
  node: TSESTree.ImportDeclaration,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => {
  const source = node.source.value;
  if (!FUNCTION_MODULE_RE.test(source) && node.importKind !== "type" && !hasOnlyNamespaceSpecifier(node)) {
    report({ node, messageId: "useNamespaceImport", data: { source } });
  }
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
      if (!node.source.value.startsWith("fp-ts/")) {
        return;
      }
      checkTopLevelPath(node, (d) => { context.report(d); });
      checkNamespaceImport(node, (d) => { context.report(d); });
    },
  }),
});
