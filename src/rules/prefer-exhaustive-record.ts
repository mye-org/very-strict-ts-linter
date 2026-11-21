import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow, pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../utils/create-rule.js";
import { isFiniteExhaustiveCandidate } from "../utils/type-helpers.js";

type MessageIds =
  | "noPartialFiniteRecord"
  | "preferFiniteRecordLookup"
  | "noObjectKeysWidening";

const OPTIONS_OR_CONFIG_RE = /(Options|Config|Props)$/;
const OBJECT_KEY_METHODS = new Set(["keys", "entries"]);

const isBooleanOnly = (type: ts.Type) =>
  Boolean(type.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) ||
  (type.isUnion() &&
    pipe(
      type.types,
      RA.every((t) => Boolean(t.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral))),
    ));

const isFiniteNonBooleanKey = (type: ts.Type) =>
  !isBooleanOnly(type) &&
  !(type.flags & ts.TypeFlags.String) &&
  isFiniteExhaustiveCandidate(type);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive ancestor walk
const isInsideOptionsTypeAlias = (node: TSESTree.Node): boolean =>
  pipe(
    O.fromNullable(node.parent),
    O.exists(
      (parent) =>
        (parent.type === AST_NODE_TYPES.TSTypeAliasDeclaration &&
          OPTIONS_OR_CONFIG_RE.test(parent.id.name)) ||
        isInsideOptionsTypeAlias(parent),
    ),
  );

const getPartialRecordKeyType = (node: TSESTree.TSTypeReference) =>
  node.typeName.type === AST_NODE_TYPES.Identifier &&
  node.typeName.name === "Partial" &&
  node.typeArguments?.params[0]?.type === AST_NODE_TYPES.TSTypeReference &&
  node.typeArguments.params[0].typeName.type === AST_NODE_TYPES.Identifier &&
  node.typeArguments.params[0].typeName.name === "Record"
    ? O.fromNullable(node.typeArguments.params[0].typeArguments?.params[0])
    : O.none;

const isPartialFiniteRecordNode = (
  node: TSESTree.TSTypeReference,
  services: ParserServicesWithTypeInformation,
) =>
  !isInsideOptionsTypeAlias(node) &&
  pipe(
    getPartialRecordKeyType(node),
    O.exists(
      flow(
        (keyNode) => services.esTreeNodeToTSNodeMap.get(keyNode),
        (tsNode) => services.program.getTypeChecker().getTypeAtLocation(tsNode),
        isFiniteNonBooleanKey,
      ),
    ),
  );

const isWideStringIndexRecord = (type: ts.Type, checker: ts.TypeChecker) =>
  type.getProperties().length === 0 &&
  Boolean(checker.getIndexInfoOfType(type, ts.IndexKind.String));

const isWideStringMap = (type: ts.Type, checker: ts.TypeChecker) => {
  const symName = type.getSymbol()?.name;
  return (
    (symName === "ReadonlyMap" || symName === "Map") &&
    pipe(
      checker.getTypeArguments(type as ts.TypeReference),
      RA.head,
      O.exists((kType) => Boolean(kType.flags & ts.TypeFlags.String)),
    )
  );
};

const getNodeTsType = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) =>
  services.program
    .getTypeChecker()
    .getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));

const isNodeModulesFile = (file: string) => file.includes("/node_modules/");

const getFirstDeclFile = (
  tsNode: ts.Node,
  type: ts.Type,
  checker: ts.TypeChecker,
) =>
  O.fromNullable(
    (
      type.aliasSymbol?.declarations?.[0] ??
      type.getSymbol()?.declarations?.[0] ??
      checker.getSymbolAtLocation(tsNode)?.declarations?.[0]
    )?.getSourceFile().fileName,
  );

const BUILTIN_MAP_OR_RECORD = new Set(["Record", "ReadonlyMap", "Map"]);

const isExternalLibraryType = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  const type = checker.getTypeAtLocation(tsNode);
  return (
    !BUILTIN_MAP_OR_RECORD.has(type.aliasSymbol?.name ?? type.getSymbol()?.name ?? "") &&
    pipe(getFirstDeclFile(tsNode, type, checker), O.exists(isNodeModulesFile))
  );
};

const isWideRecordIndexedByFiniteKey = (
  node: TSESTree.MemberExpression,
  services: ParserServicesWithTypeInformation,
) =>
  node.computed &&
  !isExternalLibraryType(node.object, services) &&
  isWideStringIndexRecord(getNodeTsType(node.object, services), services.program.getTypeChecker()) &&
  isFiniteNonBooleanKey(getNodeTsType(node.property, services));

const isWideMapGetWithFiniteKey = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) =>
  node.callee.type === AST_NODE_TYPES.MemberExpression &&
  node.callee.property.type === AST_NODE_TYPES.Identifier &&
  node.callee.property.name === "get" &&
  !isExternalLibraryType(node.callee.object, services) &&
  Boolean(node.arguments[0]) &&
  isWideStringMap(getNodeTsType(node.callee.object, services), services.program.getTypeChecker()) &&
  Boolean(node.arguments[0] && isFiniteNonBooleanKey(getNodeTsType(node.arguments[0], services)));

const hasKnownFiniteProperties = (type: ts.Type, checker: ts.TypeChecker) =>
  type.getProperties().length > 0 && !checker.getIndexInfoOfType(type, ts.IndexKind.String);

const isObjectKeysOnFiniteObject = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) =>
  node.callee.type === AST_NODE_TYPES.MemberExpression &&
  node.callee.object.type === AST_NODE_TYPES.Identifier &&
  node.callee.object.name === "Object" &&
  node.callee.property.type === AST_NODE_TYPES.Identifier &&
  OBJECT_KEY_METHODS.has(node.callee.property.name) &&
  Boolean(
    node.arguments[0] &&
      hasKnownFiniteProperties(
        getNodeTsType(node.arguments[0], services),
        services.program.getTypeChecker(),
      ),
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
  pipe(msg, O.map((messageId) => { report({ node, messageId }); }));
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
        "Avoid looking up a finite union/literal key in a wide `string`-keyed `Record` or `Map`. Type the collection as `Record<KeyUnion, V>` for compile-time key checks.",
      noObjectKeysWidening:
        "`Object.keys`/`Object.entries` widens finite keys to `string`. Use `fp-ts/ReadonlyRecord` or typed key iteration to preserve `keyof T` at compile time.",
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
