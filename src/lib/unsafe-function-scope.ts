import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";

const UNSAFE_SUFFIX_RE = /[a-z0-9]Unsafe$/;
const MUST_PREFIX_RE = /^must[A-Z]/;

export const isUnsafeOrMustName = (name: string) =>
  UNSAFE_SUFFIX_RE.test(name) || MUST_PREFIX_RE.test(name);

const resolveNamedParentKey = (gp: TSESTree.Node) =>
  match(gp)
    .with({ type: AST_NODE_TYPES.VariableDeclarator, id: { type: AST_NODE_TYPES.Identifier } }, (d) => O.some(d.id.name))
    .with({ type: AST_NODE_TYPES.Property, key: { type: AST_NODE_TYPES.Identifier } }, (p) => O.some(p.key.name))
    .with({ type: AST_NODE_TYPES.MethodDefinition, key: { type: AST_NODE_TYPES.Identifier } }, (p) => O.some(p.key.name))
    .with({ type: AST_NODE_TYPES.PropertyDefinition, key: { type: AST_NODE_TYPES.Identifier } }, (p) => O.some(p.key.name))
    .with(P._, () => O.none)
    .exhaustive();

export const resolveDirectFunctionName = (node: TSESTree.Node) =>
  match(node)
    .with({ type: AST_NODE_TYPES.FunctionDeclaration }, (fn) => (fn.id ? O.some(fn.id.name) : O.none))
    .with({ type: AST_NODE_TYPES.FunctionExpression }, (fn) =>
      fn.id ? O.some(fn.id.name) : resolveNamedParentKey(fn.parent),
    )
    .with({ type: AST_NODE_TYPES.ArrowFunctionExpression }, (fn) => resolveNamedParentKey(fn.parent))
    .with({ type: AST_NODE_TYPES.MethodDefinition }, (m) =>
      m.key.type === AST_NODE_TYPES.Identifier ? O.some(m.key.name) : O.none,
    )
    .with(P._, () => O.none)
    .exhaustive();

const isMatchingDirectOrAncestor = (
  parent: TSESTree.Node,
  predicate: (name: string) => boolean,
) =>
  O.exists(predicate)(resolveDirectFunctionName(parent)) ||
  hasMatchingEnclosingFunctionName(parent, predicate);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive ancestor search
export const hasMatchingEnclosingFunctionName = (node: TSESTree.Node, predicate: (name: string) => boolean): boolean =>
  flow(
    (n: TSESTree.Node) => n.parent,
    O.fromNullable,
    O.exists((parent) => isMatchingDirectOrAncestor(parent, predicate)),
  )(node);

export const isInsideUnsafeOrMustFunction = (node: TSESTree.Node) =>
  hasMatchingEnclosingFunctionName(node, isUnsafeOrMustName);
