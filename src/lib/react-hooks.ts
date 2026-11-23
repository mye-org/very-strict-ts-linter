import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
import { resolveCalleeName } from "./reanimated-worklet.js";
import { resolveDirectFunctionName } from "./unsafe-function-scope.js";

const isUpperChar = (ch: string) => ch >= "A" && ch <= "Z";
const isDigitChar = (ch: string) => ch >= "0" && ch <= "9";

export const isHookName = (name: string): boolean =>
  name.startsWith("use") &&
  O.exists((ch: string) => isUpperChar(ch) || isDigitChar(ch))(O.fromNullable(name[3]));

export const isHookCallExpr = flow(
  O.filter(
    (n: TSESTree.Expression): n is TSESTree.CallExpression =>
      n.type === AST_NODE_TYPES.CallExpression,
  ),
  O.flatMap((c) => resolveCalleeName(c.callee)),
  O.exists(isHookName),
);

export const isCustomHookFn = flow(resolveDirectFunctionName, O.exists(isHookName));
