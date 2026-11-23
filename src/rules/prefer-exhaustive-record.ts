import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../lib/rule-factory.js";
import { normalizeFilePath } from "../lib/source-paths.js";
import { isFiniteExhaustiveCandidate } from "../lib/finite-types.js";

const FINITE_KEY_LITERAL_FLAGS =
  ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.EnumLiteral;

const isFiniteUnionOrEnumKey = (type: ts.Type) =>
  (type.flags & (ts.TypeFlags.Enum | ts.TypeFlags.EnumLiteral)) !== 0 ||
  (type.isUnion() &&
    type.types.length >= 2 &&
    RA.every((member: ts.Type) => (member.flags & FINITE_KEY_LITERAL_FLAGS) !== 0)(type.types));

type MessageIds =
  | "noPartialFiniteRecord"
  | "preferFiniteRecordLookup"
  | "noObjectKeysWidening";

const OPTIONS_OR_CONFIG_RE = /(Options|Config|Props)$/;
const OBJECT_KEY_METHODS = new Set(["keys", "entries"]);
const PARTIAL_TYPE_NAMES: ReadonlySet<string> = new Set(["Partial"]);
const RECORD_TYPE_NAMES: ReadonlySet<string> = new Set(["Record"]);
const GET_METHOD_NAMES: ReadonlySet<string> = new Set(["get"]);
const OBJECT_GLOBAL_NAMES: ReadonlySet<string> = new Set(["Object"]);
const BUILTIN_MAP_OR_RECORD = new Set(["Record", "ReadonlyRecord", "ReadonlyMap", "Map"]);

const isBooleanTypeFlag = (flags: ts.TypeFlags) =>
  Boolean(flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral));

const isStringTypeFlag = (type: ts.Type) => Boolean(type.flags & ts.TypeFlags.String);

const isBooleanOnly = (type: ts.Type) =>
  isBooleanTypeFlag(type.flags) ||
  (type.isUnion() && RA.every((t: ts.Type) => isBooleanTypeFlag(t.flags))(type.types));

const isFiniteNonBooleanKey = (type: ts.Type) =>
  !isBooleanOnly(type) &&
  !(type.flags & ts.TypeFlags.String) &&
  isFiniteExhaustiveCandidate(type);

const isOptionsOrConfigName = (name: string) => OPTIONS_OR_CONFIG_RE.test(name);

const isInsideOptionsTypeAlias: Pred.Predicate<TSESTree.Node> = flow(
  (n: TSESTree.Node) => O.fromNullable(n.parent),
  O.exists(
    (parent) =>
      (parent.type === AST_NODE_TYPES.TSTypeAliasDeclaration &&
        isOptionsOrConfigName(parent.id.name)) ||
      isInsideOptionsTypeAlias(parent),
  ),
);

const isTypeRefNamed = (
  node: TSESTree.TypeNode,
  names: ReadonlySet<string>,
): node is TSESTree.TSTypeReference =>
  node.type === AST_NODE_TYPES.TSTypeReference &&
  node.typeName.type === AST_NODE_TYPES.Identifier &&
  names.has(node.typeName.name);

const resolveFirstTypeArg = flow(
  (ref: TSESTree.TSTypeReference) => O.fromNullable(ref.typeArguments),
  O.flatMap((ta) => O.fromNullable(ta.params[0])),
);

const resolvePartialRecordKeyType = flow(
  O.fromPredicate((n: TSESTree.TSTypeReference) => isTypeRefNamed(n, PARTIAL_TYPE_NAMES)),
  O.flatMap(resolveFirstTypeArg),
  O.filter((inner): inner is TSESTree.TSTypeReference =>
    isTypeRefNamed(inner, RECORD_TYPE_NAMES),
  ),
  O.flatMap(resolveFirstTypeArg),
);

const resolveNodeTsType = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) =>
  services.program
    .getTypeChecker()
    .getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));

const isFiniteNonBooleanNode = (
  keyNode: TSESTree.TypeNode,
  services: ParserServicesWithTypeInformation,
) => isFiniteNonBooleanKey(resolveNodeTsType(keyNode, services));

const isPartialFiniteRecordNode = (
  node: TSESTree.TSTypeReference,
  services: ParserServicesWithTypeInformation,
) =>
  !isInsideOptionsTypeAlias(node) &&
  O.exists((keyNode: TSESTree.TypeNode) => isFiniteNonBooleanNode(keyNode, services))(
    resolvePartialRecordKeyType(node),
  );

const isStringIndexed = (type: ts.Type, checker: ts.TypeChecker) => {
  const check = flow(
    (t: ts.Type) => checker.getIndexInfoOfType(t, ts.IndexKind.String),
    O.fromNullable,
    O.isSome,
  );
  return check(type);
};

const isWideStringIndexRecord = (type: ts.Type, checker: ts.TypeChecker) =>
  type.getProperties().length === 0 && isStringIndexed(type, checker);

const isTsTypeReference = (type: ts.Type): type is ts.TypeReference =>
  (type.flags & ts.TypeFlags.Object) !== 0 &&
  "objectFlags" in type &&
  typeof type.objectFlags === "number" &&
  (type.objectFlags & ts.ObjectFlags.Reference) !== 0;

const hasStringFirstTypeArg = (type: ts.TypeReference, checker: ts.TypeChecker) => {
  const check = flow(
    (t: ts.TypeReference) => checker.getTypeArguments(t),
    RA.head<ts.Type>,
    O.exists(isStringTypeFlag),
  );
  return check(type);
};

const isWideStringMap = (type: ts.Type, checker: ts.TypeChecker) => {
  const symName = type.getSymbol()?.name;
  return (
    (symName === "ReadonlyMap" || symName === "Map") &&
    isTsTypeReference(type) &&
    hasStringFirstTypeArg(type, checker)
  );
};

const isNodeModulesSegment = (normalized: string) =>
  normalized.includes("/node_modules/");

const isNodeModulesFile = flow(normalizeFilePath, isNodeModulesSegment);

const resolveSymbolFirstDecl = O.flatMap((s: ts.Symbol) => O.fromNullable(s.declarations?.[0]));

const resolveAliasDecl = flow(
  (type: ts.Type) => O.fromNullable(type.aliasSymbol),
  resolveSymbolFirstDecl,
);

const resolveTypeDecl = flow(
  (type: ts.Type) => type.getSymbol(),
  O.fromNullable,
  resolveSymbolFirstDecl,
);

const resolveNodeSymbolDecl = (tsNode: ts.Node, checker: ts.TypeChecker) => {
  const resolve = flow(
    (n: ts.Node) => checker.getSymbolAtLocation(n),
    O.fromNullable,
    resolveSymbolFirstDecl,
  );
  return resolve(tsNode);
};

const resolveFirstDeclFile = (
  tsNode: ts.Node,
  type: ts.Type,
  checker: ts.TypeChecker,
) => {
  const resolve = flow(
    resolveAliasDecl,
    O.alt(() => resolveTypeDecl(type)),
    O.alt(() => resolveNodeSymbolDecl(tsNode, checker)),
    O.map((decl: ts.Declaration) => decl.getSourceFile().fileName),
  );
  return resolve(type);
};

const isExternalLibraryType = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  const type = checker.getTypeAtLocation(tsNode);
  return (
    !BUILTIN_MAP_OR_RECORD.has(type.aliasSymbol?.name ?? type.getSymbol()?.name ?? "") &&
    O.exists(isNodeModulesFile)(resolveFirstDeclFile(tsNode, type, checker))
  );
};

const isWideRecordIndexedByFiniteKey = (
  node: TSESTree.MemberExpression,
  services: ParserServicesWithTypeInformation,
) =>
  node.computed &&
  !isExternalLibraryType(node.object, services) &&
  isWideStringIndexRecord(resolveNodeTsType(node.object, services), services.program.getTypeChecker()) &&
  isFiniteUnionOrEnumKey(resolveNodeTsType(node.property, services));

const isGetMemberProperty = (member: TSESTree.MemberExpression) =>
  !member.computed &&
  member.property.type === AST_NODE_TYPES.Identifier &&
  GET_METHOD_NAMES.has(member.property.name);

const isWideMapGetWithFiniteKey = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) =>
  node.callee.type === AST_NODE_TYPES.MemberExpression &&
  isGetMemberProperty(node.callee) &&
  !isExternalLibraryType(node.callee.object, services) &&
  isWideStringMap(resolveNodeTsType(node.callee.object, services), services.program.getTypeChecker()) &&
  O.exists(
    flow(
      (arg: TSESTree.CallExpressionArgument) => resolveNodeTsType(arg, services),
      isFiniteUnionOrEnumKey,
    ),
  )(O.fromNullable(node.arguments[0]));

const hasKnownFiniteProperties = (type: ts.Type, checker: ts.TypeChecker) =>
  type.getProperties().length > 0 && !checker.getIndexInfoOfType(type, ts.IndexKind.String);

const isFiniteObjectArg = (
  arg: TSESTree.CallExpressionArgument,
  services: ParserServicesWithTypeInformation,
) => hasKnownFiniteProperties(resolveNodeTsType(arg, services), services.program.getTypeChecker());

const isObjectKeysCallee = (member: TSESTree.MemberExpression) =>
  !member.computed &&
  member.object.type === AST_NODE_TYPES.Identifier &&
  OBJECT_GLOBAL_NAMES.has(member.object.name) &&
  member.property.type === AST_NODE_TYPES.Identifier &&
  OBJECT_KEY_METHODS.has(member.property.name);

const isObjectKeysOnFiniteObject = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) =>
  node.callee.type === AST_NODE_TYPES.MemberExpression &&
  isObjectKeysCallee(node.callee) &&
  O.exists((arg: TSESTree.CallExpressionArgument) => isFiniteObjectArg(arg, services))(
    O.fromNullable(node.arguments[0]),
  );

const checkCallExpression = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
  report: (n: TSESTree.Node, id: MessageIds) => void,
) => {
  match({
    isMapGet: isWideMapGetWithFiniteKey(node, services),
    isObjectKeys: isObjectKeysOnFiniteObject(node, services),
  })
    .with({ isMapGet: true }, () => { report(node, "preferFiniteRecordLookup"); })
    .with({ isObjectKeys: true }, () => { report(node, "noObjectKeysWidening"); })
    .with(P._, () => {})
    .exhaustive();
};

const reportOpt = (
  node: TSESTree.Node,
  msg: O.Option<MessageIds>,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  O.map((messageId: MessageIds) => { report({ node, messageId }); })(msg);
};

export const preferExhaustiveRecord = createRule<[], MessageIds>({
  name: "prefer-exhaustive-record",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Encourage exhaustive `Record<FiniteUnion, V>` mapped types over `Partial<Record<...>>`, wide `string`-keyed lookups with finite keys, and `Object.keys`/`Object.entries` widening.",
    },
    messages: {
      noPartialFiniteRecord:
        "Avoid `Partial<Record<K, V>>` on finite union keys. Use `Record<K, V>` (with `Option<V>` values if optional) so missing variants fail at compile time.",
      preferFiniteRecordLookup:
        "Avoid looking up a finite union/enum key in a wide `string`-keyed `Record` or `Map`. Type the collection as `Record<KeyUnion, V>` for compile-time key checks.",
      noObjectKeysWidening:
        "`Object.keys`/`Object.entries` widens finite keys to `string`. Use `fp-ts/lib/ReadonlyRecord` or typed key iteration to preserve `keyof T` at compile time.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const services = ESLintUtils.getParserServices(context);
    const rep = (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => { context.report(d); };
    return {
      TSTypeReference: (node) => { reportOpt(node, isPartialFiniteRecordNode(node, services) ? O.some("noPartialFiniteRecord") : O.none, rep); },
      MemberExpression: (node) => { reportOpt(node, isWideRecordIndexedByFiniteKey(node, services) ? O.some("preferFiniteRecordLookup") : O.none, rep); },
      CallExpression: (node) => { checkCallExpression(node, services, (n, messageId) => { context.report({ node: n, messageId }); }); },
    };
  },
});
