import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow, pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";

export const isUnsafeOrMustName = (name: string) =>
  name.endsWith("Unsafe") || name.startsWith("must");

const getNamedParentKey = (gp: TSESTree.Node) => {
  if (gp.type === AST_NODE_TYPES.VariableDeclarator && gp.id.type === AST_NODE_TYPES.Identifier) {
    return O.some(gp.id.name);
  }
  if (
    (gp.type === AST_NODE_TYPES.Property || gp.type === AST_NODE_TYPES.MethodDefinition) &&
    gp.key.type === AST_NODE_TYPES.Identifier
  ) {
    return O.some(gp.key.name);
  }
  return O.none;
};

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive callback
const getEnclosingFunctionName = (node: TSESTree.Node): O.Option<string> => {
  if (!node.parent) { return O.none; }
  if (node.parent.type === AST_NODE_TYPES.FunctionDeclaration) {
    return node.parent.id ? O.some(node.parent.id.name) : O.none;
  }
  if (node.parent.type === AST_NODE_TYPES.FunctionExpression || node.parent.type === AST_NODE_TYPES.ArrowFunctionExpression) {
    return getNamedParentKey(node.parent.parent);
  }
  if (node.parent.type === AST_NODE_TYPES.MethodDefinition) {
    return node.parent.key.type === AST_NODE_TYPES.Identifier ? O.some(node.parent.key.name) : O.none;
  }
  return getEnclosingFunctionName(node.parent);
};

export const isInsideUnsafeOrMustFunction = (node: TSESTree.Node) =>
  pipe(getEnclosingFunctionName(node), O.exists(isUnsafeOrMustName));

const isNewtypeReference = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.TSTypeReference &&
  node.typeName.type === AST_NODE_TYPES.Identifier &&
  node.typeName.name === "Newtype";

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const hasNewtypeAncestor = (node: TSESTree.Node): boolean =>
  isNewtypeReference(node) || walkUpForNewtype(O.fromNullable(node.parent));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const walkUpForNewtype = (current: O.Option<TSESTree.Node>): boolean =>
  pipe(current, O.exists(hasNewtypeAncestor));

export const isInsideNewtypeDefinition = flow(
  (node: TSESTree.Node) => O.fromNullable(node.parent),
  walkUpForNewtype,
);

export const isPredicateReturnType = (node: TSESTree.Node) =>
  node.parent?.type === AST_NODE_TYPES.TSTypeAnnotation &&
  (node.parent.parent.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.parent.parent.type === AST_NODE_TYPES.FunctionDeclaration ||
    node.parent.parent.type === AST_NODE_TYPES.FunctionExpression ||
    node.parent.parent.type === AST_NODE_TYPES.TSFunctionType);

const isArraySymbol = (type: ts.Type) => {
  const name = type.getSymbol()?.name;
  return name === "Array" || name === "ReadonlyArray";
};

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive callback
export const isArrayLikeType = (type: ts.Type, checker: ts.TypeChecker): boolean => {
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return true;
  }
  if (type.isUnion()) {
    return pipe(type.types, RA.every((t) => isArrayLikeType(t, checker)));
  }
  return isArraySymbol(type);
};

const isBooleanOrLiteralOrEnum = (type: ts.Type) =>
  Boolean(
    type.flags &
      (ts.TypeFlags.Boolean |
        ts.TypeFlags.BooleanLiteral |
        ts.TypeFlags.Enum |
        ts.TypeFlags.EnumLiteral |
        ts.TypeFlags.StringLiteral |
        ts.TypeFlags.NumberLiteral),
  );

const isDiscriminatedObject = (type: ts.Type) =>
  pipe(
    type.getProperties(),
    RA.some(
      (prop) =>
        prop.name === "kind" ||
        prop.name === "type" ||
        prop.name === "_tag" ||
        prop.name === "tag",
    ),
  );

export const isFiniteExhaustiveCandidate = (type: ts.Type) =>
  isBooleanOrLiteralOrEnum(type) ||
  (type.isUnion() &&
    pipe(
      type.types,
      RA.every(
        flow(
          (member) =>
            isBooleanOrLiteralOrEnum(member) || isDiscriminatedObject(member),
        ),
      ),
    ));
