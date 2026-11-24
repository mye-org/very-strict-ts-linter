import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { match, P } from "ts-pattern";

const UNSAFE_SUFFIX_RE = /[a-z0-9]Unsafe$/;
const MUST_PREFIX_RE = /^must[A-Z]/;

export const isUnsafeOrMustName = ((name: string) =>
  UNSAFE_SUFFIX_RE.test(name) || MUST_PREFIX_RE.test(name)) satisfies (name: string) => boolean;

const resolveNamedParentKey = (gp: TSESTree.Node) =>
  match(gp.type === AST_NODE_TYPES.TSSatisfiesExpression ? gp.parent : gp)
    .with({ type: AST_NODE_TYPES.VariableDeclarator, id: { type: AST_NODE_TYPES.Identifier } }, (d) => O.some(d.id.name))
    .with(
      { type: AST_NODE_TYPES.Property, key: { type: AST_NODE_TYPES.Identifier } },
      { type: AST_NODE_TYPES.MethodDefinition, key: { type: AST_NODE_TYPES.Identifier } },
      { type: AST_NODE_TYPES.PropertyDefinition, key: { type: AST_NODE_TYPES.Identifier } },
      (p) => O.some(p.key.name),
    )
    .with(P._, () => O.none)
    .exhaustive();

export const resolveDirectFunctionName = ((node: TSESTree.Node) =>
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
    .exhaustive()) satisfies (node: TSESTree.Node) => O.Option<string>;

const isMatchingDirectOrAncestor: (
  parent: TSESTree.Node,
  predicate: (name: string) => boolean,
) => boolean = (parent, predicate) =>
  O.exists(predicate)(resolveDirectFunctionName(parent)) ||
  hasMatchingEnclosingFunctionName(parent, predicate);

export const hasMatchingEnclosingFunctionName = ((
  node: TSESTree.Node,
  predicate: (name: string) => boolean,
) =>
  O.exists((parent: TSESTree.Node) => isMatchingDirectOrAncestor(parent, predicate))(
    O.fromNullable(node.parent),
  )) satisfies (node: TSESTree.Node, predicate: (name: string) => boolean) => boolean;

export const isInsideUnsafeOrMustFunction = ((node: TSESTree.Node) =>
  hasMatchingEnclosingFunctionName(node, isUnsafeOrMustName)) satisfies (
  node: TSESTree.Node,
) => boolean;
