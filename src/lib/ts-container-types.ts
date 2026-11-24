import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

const WRAPPER_CONTAINER_NAMES = new Set([
  "Array",
  "ReadonlyArray",
  "Readonly",
  "Partial",
  "Required",
  "Set",
  "ReadonlySet",
  "Option",
  "Result",
  "Promise",
  "Task",
  "IO",
  "IOEither",
  "Either",
  "TaskEither",
  "ReaderTaskEither",
  "Effect",
  "Observable",
]);

const IGNORED_UNION_FLAGS =
  ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never;

const EMPTY_TS_TYPES: ReadonlyArray<ts.Type> = [];

const isTypeReference = (type: ts.Type): type is ts.TypeReference =>
  (type.flags & ts.TypeFlags.Object) !== 0 && "target" in type;

const resolveDirectSymbol = flow((t: ts.Type) => t.getSymbol(), O.fromNullable);

const resolveTypeSymbolName = (type: ts.Type) =>
  flow(
    (t: ts.Type) => t.aliasSymbol,
    O.fromNullable,
    O.alt(() => resolveDirectSymbol(type)),
    O.map((sym) => sym.name),
  );

const resolveTypeArguments = (checker: ts.TypeChecker) => (type: ts.Type) => {
  const resolve = flow(
    (t: ts.Type) => t.aliasTypeArguments,
    O.fromNullable,
    O.getOrElse(() =>
      isTypeReference(type) ? checker.getTypeArguments(type) : EMPTY_TS_TYPES,
    ),
  );
  return resolve(type);
};

const resolveContainerTypeArgs = (checker: ts.TypeChecker) => (type: ts.Type) =>
  O.exists((name: string) => WRAPPER_CONTAINER_NAMES.has(name))(resolveTypeSymbolName(type)(type))
    ? resolveTypeArguments(checker)(type)
    : EMPTY_TS_TYPES;

const unwrapArgList =
  (checker: ts.TypeChecker) =>
  (fallback: ts.Type) =>
  (args: ReadonlyArray<ts.Type>) =>
    args.length > 0
      ? RA.flatMap(unwrapContainerTsTypesImpl(checker))(args)
      : [fallback];

const isMeaningfulUnionMember = (m: ts.Type) => (m.flags & IGNORED_UNION_FLAGS) === 0;

const unwrapMeaningfulUnionMembers = (checker: ts.TypeChecker) =>
  flow(
    RA.filter(isMeaningfulUnionMember),
    RA.flatMap(unwrapContainerTsTypesImpl(checker)),
  );

const unwrapContainerTsTypesImpl: (
  checker: ts.TypeChecker,
) => (type: ts.Type) => ReadonlyArray<ts.Type> = (checker) => (type) =>
  type.isUnion()
    ? unwrapMeaningfulUnionMembers(checker)(type.types)
    : unwrapArgList(checker)(type)(resolveContainerTypeArgs(checker)(type));

export const unwrapContainerTsTypes = unwrapContainerTsTypesImpl satisfies (
  checker: ts.TypeChecker,
) => (type: ts.Type) => ReadonlyArray<ts.Type>;
