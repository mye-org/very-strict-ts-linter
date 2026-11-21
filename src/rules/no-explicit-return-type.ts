import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { match, P } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "noExplicitReturnType";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

export const noExplicitReturnType = createRule<[], MessageIds>({
  name: "no-explicit-return-type",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow explicit return type annotations on functions so TypeScript infers the narrowest possible return type.",
    },
    messages: {
      noExplicitReturnType:
        "Do not specify an explicit return type on functions; let TypeScript infer the narrowest return type from the return statement.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const checkFunction = (node: FunctionNode) => {
      match(node.returnType)
        .with({ typeAnnotation: { type: P.not(AST_NODE_TYPES.TSTypePredicate) } }, (returnType) => {
          context.report({ node: returnType, messageId: "noExplicitReturnType" });
        })
        .otherwise(() => {});
    };
    return { FunctionDeclaration: checkFunction, FunctionExpression: checkFunction, ArrowFunctionExpression: checkFunction };
  },
});
