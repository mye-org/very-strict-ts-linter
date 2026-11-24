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

const resolveAliasSymbol = flow((t: ts.Type) => t.aliasSymbol, O.fromNullable);
const resolveDirectSymbol = flow((t: ts.Type) => t.getSymbol(), O.fromNullable);

const resolveTypeSymbolName = (type: ts.Type) =>
  flow(
    resolveAliasSymbol,
    O.alt(() => resolveDirectSymbol(type)),
    O.map((sym) => sym.name),
  );

const resolveTypeArguments = (type: ts.Type, checker: ts.TypeChecker) =>
  O.getOrElse(() =>
    isTypeReference(type) ? checker.getTypeArguments(type) : EMPTY_TS_TYPES,
  )(O.fromNullable(type.aliasTypeArguments));

const resolveContainerTypeArgs = (type: ts.Type, checker: ts.TypeChecker) =>
  O.exists((name: string) => WRAPPER_CONTAINER_NAMES.has(name))(resolveTypeSymbolName(type)(type))
    ? resolveTypeArguments(type, checker)
    : EMPTY_TS_TYPES;

const unwrapArgList: (
  checker: ts.TypeChecker,
) => (args: ReadonlyArray<ts.Type>, fallback: ts.Type) => ReadonlyArray<ts.Type> =
  (checker) => (args, fallback) =>
    args.length > 0
      ? RA.flatMap((arg: ts.Type) => unwrapContainerTsTypes(arg, checker))(args)
      : [fallback];

const isMeaningfulUnionMember = (m: ts.Type) => (m.flags & IGNORED_UNION_FLAGS) === 0;

const unwrapMeaningfulUnionMembers: (
  checker: ts.TypeChecker,
) => (types: ReadonlyArray<ts.Type>) => ReadonlyArray<ts.Type> = (checker) =>
  flow(
    RA.filter(isMeaningfulUnionMember),
    RA.flatMap((m: ts.Type) => unwrapContainerTsTypes(m, checker)),
  );

export const unwrapContainerTsTypes = ((type: ts.Type, checker: ts.TypeChecker) =>
  type.isUnion()
    ? unwrapMeaningfulUnionMembers(checker)(type.types)
    : unwrapArgList(checker)(resolveContainerTypeArgs(type, checker), type)) satisfies (
  type: ts.Type,
  checker: ts.TypeChecker,
) => ReadonlyArray<ts.Type>;
