import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as IO from "fp-ts/lib/IO.js";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { isFlowCallExpression } from "../lib/flow-call.js";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "noSingleUseMicroFlow";

type ReportDescriptor = Readonly<{
  node: TSESTree.Node;
  messageId: MessageIds;
  data: Readonly<Record<string, string>>;
}>;

type MicroFlowFinding = Readonly<{
  declarator: TSESTree.VariableDeclarator;
  name: string;
}>;

const isTwoArgFlowCall = (init: TSESTree.Expression): init is TSESTree.CallExpression =>
  init.type === AST_NODE_TYPES.CallExpression &&
  isFlowCallExpression(init) &&
  init.arguments.length === 2;

const isModuleLevelConstDecl = (node: TSESTree.VariableDeclaration) =>
  node.kind === "const" && node.parent.type === AST_NODE_TYPES.Program;

const isArgOfOtherFlowCall =
  (ownInit: TSESTree.CallExpression) => (ref: TSESLint.Scope.Reference) =>
    ref.identifier.parent.type === AST_NODE_TYPES.CallExpression &&
    ref.identifier.parent !== ownInit &&
    isFlowCallExpression(ref.identifier.parent) &&
    RA.some((arg: TSESTree.CallExpressionArgument) => arg === ref.identifier)(
      ref.identifier.parent.arguments,
    );

const getSingleReadRef = flow(
  RA.filter((ref: TSESLint.Scope.Reference) => ref.isRead()),
  O.fromPredicate((refs: ReadonlyArray<TSESLint.Scope.Reference>) => refs.length === 1),
  O.flatMap(RA.head),
);

const hasSingleFlowRef = (init: TSESTree.CallExpression) =>
  flow(
    (v: TSESLint.Scope.Variable) => v.references,
    getSingleReadRef,
    O.exists(isArgOfOtherFlowCall(init)),
  );

const hasEntryFlowRef = (init: TSESTree.CallExpression) =>
  flow(
    (entry: Readonly<{ v: TSESLint.Scope.Variable }>) => entry.v,
    hasSingleFlowRef(init),
  );

const checkDeclaratorWithFlowInit =
  (sourceCode: Readonly<TSESLint.SourceCode>) => (init: TSESTree.CallExpression) =>
    flow(
      O.of<TSESTree.VariableDeclarator>,
      O.bindTo("declarator"),
      O.bind("v", ({ declarator }) =>
        O.fromNullable(sourceCode.getDeclaredVariables(declarator)[0]),
      ),
      O.filter(hasEntryFlowRef(init)),
      O.map(({ declarator, v }): MicroFlowFinding => ({ declarator, name: v.name })),
    );

const resolveMicroFlowFinding =
  (sourceCode: Readonly<TSESLint.SourceCode>) =>
  (declarator: TSESTree.VariableDeclarator) =>
    declarator.id.type === AST_NODE_TYPES.Identifier &&
    declarator.init !== null &&
    isTwoArgFlowCall(declarator.init)
      ? checkDeclaratorWithFlowInit(sourceCode)(declarator.init)(declarator)
      : O.none;

const reportMicroFlowFinding =
  (report: (d: ReportDescriptor) => void) =>
  ({ declarator, name }: MicroFlowFinding) =>
  () => {
    report({ node: declarator, messageId: "noSingleUseMicroFlow", data: { name } });
  };

const reportMicroFlowDeclarators =
  (sourceCode: Readonly<TSESLint.SourceCode>) => (report: (d: ReportDescriptor) => void) =>
    flow(
      (node: TSESTree.VariableDeclaration) => node.declarations,
      RA.filterMap(resolveMicroFlowFinding(sourceCode)),
      RA.traverse(IO.Applicative)(reportMicroFlowFinding(report)),
    );

const runEffect = <A>(effect: IO.IO<A>) => {
  effect();
};

const handleVariableDeclaration =
  (sourceCode: Readonly<TSESLint.SourceCode>) => (report: (d: ReportDescriptor) => void) =>
    flow(
      O.fromPredicate(isModuleLevelConstDecl),
      O.traverse(IO.Applicative)(reportMicroFlowDeclarators(sourceCode)(report)),
      runEffect,
    );

export const noSingleUseMicroFlow = createRule<[], MessageIds>({
  name: "no-single-use-micro-flow",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow non-exported module-level 2-step `flow(a, b)` helpers that are only referenced once inside another `flow(...)` pipeline.",
    },
    messages: {
      noSingleUseMicroFlow:
        "Helper `{{name}}` is a single-use 2-step `flow(a, b)` referenced only in another `flow(...)`. Inline its two steps directly into the parent `flow(...)` pipeline to centralize composition.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    VariableDeclaration: handleVariableDeclaration(context.sourceCode)((d) => {
      context.report(d);
    }),
  }),
});
