import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "useLibPath" | "useNamespaceImport";

const FUNCTION_MODULE_RE = /^fp-ts\/(lib\/)?function(\.js)?$/;
const FP_TS_TOP_LEVEL_MODULE_RE = /^fp-ts\/([A-Z][A-Za-z0-9]*)$/;

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
  },
  defaultOptions: [],
  create: (context) => ({
    ImportDeclaration: (node: TSESTree.ImportDeclaration) => {
      const source = node.source.value;
      if (!source.startsWith("fp-ts/")) {
        return;
      }

      const topLevelMatch = FP_TS_TOP_LEVEL_MODULE_RE.exec(source);
      if (topLevelMatch?.[1]) {
        context.report({
          node: node.source,
          messageId: "useLibPath",
          data: { module: topLevelMatch[1] },
        });
      }

      if (FUNCTION_MODULE_RE.test(source) || node.importKind === "type") {
        return;
      }

      const hasOnlyNamespace =
        node.specifiers.length === 1 &&
        node.specifiers[0]?.type === AST_NODE_TYPES.ImportNamespaceSpecifier;

      if (!hasOnlyNamespace) {
        context.report({
          node,
          messageId: "useNamespaceImport",
          data: { source },
        });
      }
    },
  }),
});
