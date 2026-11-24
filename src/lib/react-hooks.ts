import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import { flow } from "fp-ts/lib/function.js";
import { resolveCalleeName } from "./reanimated-worklet.js";
import { resolveDirectFunctionName } from "./unsafe-function-scope.js";

const isUpperChar = (ch: string) => ch >= "A" && ch <= "Z";
const isDigitChar = (ch: string) => ch >= "0" && ch <= "9";
const hasUsePrefix = (name: string) => name.startsWith("use");
const isUpperOrDigit = Pred.or(isUpperChar)(isDigitChar);
const hasHookFourthChar = flow(
  (name: string) => name[3],
  O.fromNullable,
  O.exists(isUpperOrDigit),
);

export const isHookName = Pred.and(hasUsePrefix)(hasHookFourthChar) satisfies (
  name: string,
) => boolean;

export const isHookCallExpr = flow(
  O.filter(
    (n: TSESTree.Expression): n is TSESTree.CallExpression =>
      n.type === AST_NODE_TYPES.CallExpression,
  ),
  O.flatMap((c) => resolveCalleeName(c.callee)),
  O.exists(isHookName),
);

export const isCustomHookFn = flow(resolveDirectFunctionName, O.exists(isHookName));
