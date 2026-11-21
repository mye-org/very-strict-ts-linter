import { fpTsImportConvention } from "./fp-ts-import-convention.js";
import { maxFunctionLines } from "./max-function-lines.js";
import { noAnyOrUnknown } from "./no-any-or-unknown.js";
import { noDomainRawPrimitives } from "./no-domain-raw-primitives.js";
import { noExplicitReturnType } from "./no-explicit-return-type.js";
import { noIfElseOrSwitch } from "./no-if-else-or-switch.js";
import { noImperativeLoops } from "./no-imperative-loops.js";
import { noLetOrVar } from "./no-let-or-var.js";
import { noNestedTernary } from "./no-nested-ternary.js";
import { noNullUndefined } from "./no-null-undefined.js";
import { noThrowOutsideUnsafe } from "./no-throw-outside-unsafe.js";
import { noUnnecessaryLocalConst } from "./no-unnecessary-local-const.js";
import { preferFpTsArrayMethods } from "./prefer-fp-ts-array-methods.js";
import { preferReadonlyCollections } from "./prefer-readonly-collections.js";
import { preferTypeOverInterface } from "./prefer-type-over-interface.js";
import { requireExhaustiveMatch } from "./require-exhaustive-match.js";

export const rules = {
  "fp-ts-import-convention": fpTsImportConvention,
  "max-function-lines": maxFunctionLines,
  "no-any-or-unknown": noAnyOrUnknown,
  "no-domain-raw-primitives": noDomainRawPrimitives,
  "no-explicit-return-type": noExplicitReturnType,
  "no-if-else-or-switch": noIfElseOrSwitch,
  "no-imperative-loops": noImperativeLoops,
  "no-let-or-var": noLetOrVar,
  "no-nested-ternary": noNestedTernary,
  "no-null-undefined": noNullUndefined,
  "no-throw-outside-unsafe": noThrowOutsideUnsafe,
  "no-unnecessary-local-const": noUnnecessaryLocalConst,
  "prefer-fp-ts-array-methods": preferFpTsArrayMethods,
  "prefer-readonly-collections": preferReadonlyCollections,
  "prefer-type-over-interface": preferTypeOverInterface,
  "require-exhaustive-match": requireExhaustiveMatch,
} as const;
