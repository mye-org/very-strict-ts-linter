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

const resolveContainerTypeArgs = (type: ts.Type, checker: ts.TypeChecker) => {
  const name = type.aliasSymbol?.name ?? type.getSymbol()?.name;
  return name && WRAPPER_CONTAINER_NAMES.has(name)
    ? type.aliasTypeArguments ?? checker.getTypeArguments(type as ts.TypeReference)
    : ([] as ReadonlyArray<ts.Type>);
};

const unwrapArgList = (
  args: ReadonlyArray<ts.Type>,
  fallback: ts.Type,
  checker: ts.TypeChecker,
) =>
  args.length > 0
    ? RA.flatMap((arg: ts.Type) => unwrapContainerTsTypes(arg, checker))(args)
    : [fallback];

const isMeaningfulUnionMember = (m: ts.Type) => (m.flags & IGNORED_UNION_FLAGS) === 0;

const unwrapUnionMembers = (members: ReadonlyArray<ts.Type>, checker: ts.TypeChecker) =>
  flow(
    RA.filter(isMeaningfulUnionMember),
    RA.flatMap((m: ts.Type) => unwrapContainerTsTypes(m, checker)),
  )(members);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive type unwrapping
export const unwrapContainerTsTypes = (type: ts.Type, checker: ts.TypeChecker): ReadonlyArray<ts.Type> =>
  type.isUnion()
    ? unwrapUnionMembers(type.types, checker)
    : unwrapArgList(resolveContainerTypeArgs(type, checker), type, checker);
