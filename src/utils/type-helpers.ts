import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow, pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { match } from "ts-pattern";

export const isUnsafeOrMustName = (name: string): boolean =>
  name.endsWith("Unsafe") || name.startsWith("must");

const getEnclosingFunctionName = (node: TSESTree.Node): O.Option<string> => {
  const parent = node.parent;
  if (!parent) {
    return O.none;
  }

  return match(parent)
    .with({ type: AST_NODE_TYPES.FunctionDeclaration }, (fn) =>
      fn.id ? O.some(fn.id.name) : O.none,
    )
    .with(
      { type: AST_NODE_TYPES.FunctionExpression },
      { type: AST_NODE_TYPES.ArrowFunctionExpression },
      (fn) => {
        const gp = fn.parent;
        if (
          gp.type === AST_NODE_TYPES.VariableDeclarator &&
          gp.id.type === AST_NODE_TYPES.Identifier
        ) {
          return O.some(gp.id.name);
        }
        if (
          gp.type === AST_NODE_TYPES.Property &&
          gp.key.type === AST_NODE_TYPES.Identifier
        ) {
          return O.some(gp.key.name);
        }
        if (
          gp.type === AST_NODE_TYPES.MethodDefinition &&
          gp.key.type === AST_NODE_TYPES.Identifier
        ) {
          return O.some(gp.key.name);
        }
        return O.none;
      },
    )
    .with({ type: AST_NODE_TYPES.MethodDefinition }, (m) =>
      m.key.type === AST_NODE_TYPES.Identifier ? O.some(m.key.name) : O.none,
    )
    .otherwise(() => getEnclosingFunctionName(parent));
};

export const isInsideUnsafeOrMustFunction = (node: TSESTree.Node): boolean =>
  pipe(
    getEnclosingFunctionName(node),
    O.exists(isUnsafeOrMustName),
  );

export const isInsideNewtypeDefinition = (node: TSESTree.Node): boolean => {
  const walkUp = (current: TSESTree.Node | undefined): boolean => {
    if (!current) {
      return false;
    }
    if (
      current.type === AST_NODE_TYPES.TSTypeReference &&
      current.typeName.type === AST_NODE_TYPES.Identifier &&
      current.typeName.name === "Newtype"
    ) {
      return true;
    }
    return walkUp(current.parent);
  };

  return walkUp(node.parent);
};

export const isPredicateReturnType = (node: TSESTree.Node): boolean => {
  const parent = node.parent;
  if (parent?.type !== AST_NODE_TYPES.TSTypeAnnotation) {
    return false;
  }
  const gp = parent.parent;
  return (
    gp.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    gp.type === AST_NODE_TYPES.FunctionDeclaration ||
    gp.type === AST_NODE_TYPES.FunctionExpression ||
    gp.type === AST_NODE_TYPES.TSFunctionType
  );
};

export const isArrayLikeType = (
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean => {
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return true;
  }
  if (type.isUnion()) {
    return pipe(
      type.types,
      RA.every((t) => isArrayLikeType(t, checker)),
    );
  }
  const symbol = type.getSymbol();
  return symbol !== undefined && (symbol.name === "Array" || symbol.name === "ReadonlyArray");
};

const isBooleanOrLiteralOrEnum = (type: ts.Type): boolean =>
  Boolean(
    type.flags &
      (ts.TypeFlags.Boolean |
        ts.TypeFlags.BooleanLiteral |
        ts.TypeFlags.Enum |
        ts.TypeFlags.EnumLiteral |
        ts.TypeFlags.StringLiteral |
        ts.TypeFlags.NumberLiteral),
  );

const isDiscriminatedObject = (type: ts.Type): boolean =>
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

export const isFiniteExhaustiveCandidate = (type: ts.Type): boolean => {
  if (isBooleanOrLiteralOrEnum(type)) {
    return true;
  }
  if (type.isUnion()) {
    return pipe(
      type.types,
      RA.every(
        flow(
          (member) =>
            isBooleanOrLiteralOrEnum(member) || isDiscriminatedObject(member),
        ),
      ),
    );
  }
  return false;
};
