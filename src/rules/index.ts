import { domainLayerPurity } from "./domain-layer-purity.js";
import { fpTsImportConvention } from "./fp-ts-import-convention.js";
import { maxFunctionLines } from "./max-function-lines.js";
import { noAnyOrUnknown } from "./no-any-or-unknown.js";
import { noClasses } from "./no-classes.js";
import { noCrossAggregateReference } from "./no-cross-aggregate-reference.js";
import { noDataClumps } from "./no-data-clumps.js";
import { noDomainRawPrimitives } from "./no-domain-raw-primitives.js";
import { noExplicitReturnType } from "./no-explicit-return-type.js";
import { noExternalEntityMutation } from "./no-external-entity-mutation.js";
import { noFpTsChain } from "./no-fp-ts-chain.js";
import { noIfElseOrSwitch } from "./no-if-else-or-switch.js";
import { noImperativeLoops } from "./no-imperative-loops.js";
import { noInlineInfraSideEffects } from "./no-inline-infra-side-effects.js";
import { noLetOrVar } from "./no-let-or-var.js";
import { noLifecycleFlagClusters } from "./no-lifecycle-flag-clusters.js";
import { noModelPolysemy } from "./no-model-polysemy.js";
import { noMultiRepoOrchestration } from "./no-multi-repo-orchestration.js";
import { noNestedPipe } from "./no-nested-pipe.js";
import { noNestedTernary } from "./no-nested-ternary.js";
import { noNullUndefined } from "./no-null-undefined.js";
import { noOptionalStateBags } from "./no-optional-state-bags.js";
import { noReactInTs } from "./no-react-in-ts.js";
import { noRepeatedGuardClauses } from "./no-repeated-guard-clauses.js";
import { noScatteredValidation } from "./no-scattered-validation.js";
import { noStringlyTypedDiscriminants } from "./no-stringly-typed-discriminants.js";
import { noThrowOutsideUnsafe } from "./no-throw-outside-unsafe.js";
import { noTrainWreckNavigation } from "./no-train-wreck-navigation.js";
import { noUnitSuffixedPrimitives } from "./no-unit-suffixed-primitives.js";
import { noUnnecessaryLocalConst } from "./no-unnecessary-local-const.js";
import { parseDontValidate } from "./parse-dont-validate.js";
import { preferConstSatisfies } from "./prefer-const-satisfies.js";
import { preferExhaustiveRecord } from "./prefer-exhaustive-record.js";
import { preferFpTsArrayMethods } from "./prefer-fp-ts-array-methods.js";
import { preferFunctionComposition } from "./prefer-function-composition.js";
import { preferMonadicComposition } from "./prefer-monadic-composition.js";
import { preferMonadicErrorHandling } from "./prefer-monadic-error-handling.js";
import { preferNonemptyTuple } from "./prefer-nonempty-tuple.js";
import { preferPointFree } from "./prefer-point-free.js";
import { preferReadonlyCollections } from "./prefer-readonly-collections.js";
import { preferTemplateLiteralType } from "./prefer-template-literal-type.js";
import { preferTypeLevelDispatch } from "./prefer-type-level-dispatch.js";
import { preferTypeOverInterface } from "./prefer-type-over-interface.js";
import { preferUnionOverBoolean } from "./prefer-union-over-boolean.js";
import { repositoryAggregateRootOnly } from "./repository-aggregate-root-only.js";
import { requireExhaustiveMatch } from "./require-exhaustive-match.js";
import { requireKeyofPath } from "./require-keyof-path.js";
import { singleLevelOfAbstraction } from "./single-level-of-abstraction.js";
import { thinReactComponent } from "./thin-react-component.js";
import { ubiquitousLanguage } from "./ubiquitous-language.js";

export const rules = {
  "domain-layer-purity": domainLayerPurity,
  "fp-ts-import-convention": fpTsImportConvention,
  "max-function-lines": maxFunctionLines,
  "no-any-or-unknown": noAnyOrUnknown,
  "no-classes": noClasses,
  "no-cross-aggregate-reference": noCrossAggregateReference,
  "no-data-clumps": noDataClumps,
  "no-domain-raw-primitives": noDomainRawPrimitives,
  "no-explicit-return-type": noExplicitReturnType,
  "no-external-entity-mutation": noExternalEntityMutation,
  "no-fp-ts-chain": noFpTsChain,
  "no-if-else-or-switch": noIfElseOrSwitch,
  "no-imperative-loops": noImperativeLoops,
  "no-inline-infra-side-effects": noInlineInfraSideEffects,
  "no-let-or-var": noLetOrVar,
  "no-lifecycle-flag-clusters": noLifecycleFlagClusters,
  "no-model-polysemy": noModelPolysemy,
  "no-multi-repo-orchestration": noMultiRepoOrchestration,
  "no-nested-pipe": noNestedPipe,
  "no-nested-ternary": noNestedTernary,
  "no-null-undefined": noNullUndefined,
  "no-optional-state-bags": noOptionalStateBags,
  "no-react-in-ts": noReactInTs,
  "no-repeated-guard-clauses": noRepeatedGuardClauses,
  "no-scattered-validation": noScatteredValidation,
  "no-stringly-typed-discriminants": noStringlyTypedDiscriminants,
  "no-throw-outside-unsafe": noThrowOutsideUnsafe,
  "no-train-wreck-navigation": noTrainWreckNavigation,
  "no-unit-suffixed-primitives": noUnitSuffixedPrimitives,
  "no-unnecessary-local-const": noUnnecessaryLocalConst,
  "parse-dont-validate": parseDontValidate,
  "prefer-const-satisfies": preferConstSatisfies,
  "prefer-exhaustive-record": preferExhaustiveRecord,
  "prefer-fp-ts-array-methods": preferFpTsArrayMethods,
  "prefer-function-composition": preferFunctionComposition,
  "prefer-monadic-composition": preferMonadicComposition,
  "prefer-monadic-error-handling": preferMonadicErrorHandling,
  "prefer-nonempty-tuple": preferNonemptyTuple,
  "prefer-point-free": preferPointFree,
  "prefer-readonly-collections": preferReadonlyCollections,
  "prefer-template-literal-type": preferTemplateLiteralType,
  "prefer-type-level-dispatch": preferTypeLevelDispatch,
  "prefer-type-over-interface": preferTypeOverInterface,
  "prefer-union-over-boolean": preferUnionOverBoolean,
  "repository-aggregate-root-only": repositoryAggregateRootOnly,
  "require-exhaustive-match": requireExhaustiveMatch,
  "require-keyof-path": requireKeyofPath,
  "single-level-of-abstraction": singleLevelOfAbstraction,
  "thin-react-component": thinReactComponent,
  "ubiquitous-language": ubiquitousLanguage,
} as const;
