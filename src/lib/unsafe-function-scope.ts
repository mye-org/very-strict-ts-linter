import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";

const UNSAFE_SUFFIX_RE = /[a-z0-9]Unsafe$/;
const MUST_PREFIX_RE = /^must[A-Z]/;

const hasUnsafeSuffix = (name: string) => UNSAFE_SUFFIX_RE.test(name);
const hasMustPrefix = (name: string) => MUST_PREFIX_RE.test(name);

export const isUnsafeOrMustName = Pred.or(hasUnsafeSuffix)(hasMustPrefix) satisfies (
  name: string,
) => boolean;

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

type NodePredicate = (node: TSESTree.Node) => boolean;

const isMatchingDirectOrAncestor = (predicate: (name: string) => boolean) => {
  const isMatch: NodePredicate = (parent) =>
    O.exists(predicate)(resolveDirectFunctionName(parent)) ||
    hasMatchingEnclosingFunctionName(predicate)(parent);
  return isMatch;
};

const hasMatchingEnclosingFunctionNameImpl: (
  predicate: (name: string) => boolean,
) => NodePredicate = (predicate) =>
  flow(
    (node: TSESTree.Node) => node.parent,
    O.fromNullable,
    O.exists(isMatchingDirectOrAncestor(predicate)),
  );

export const hasMatchingEnclosingFunctionName = hasMatchingEnclosingFunctionNameImpl satisfies (
  predicate: (name: string) => boolean,
) => NodePredicate;

export const isInsideUnsafeOrMustFunction = hasMatchingEnclosingFunctionName(
  isUnsafeOrMustName,
) satisfies NodePredicate;
