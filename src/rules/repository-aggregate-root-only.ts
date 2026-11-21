import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as S from "fp-ts/lib/string.js";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { analyzeAggregateGraph } from "../analyzers/aggregate-graph-analyzer.js";
import { createRule } from "../utils/create-rule.js";
import { getTsTypeName, unwrapContainerTsTypes } from "../utils/type-helpers.js";

type Options = [
  Readonly<{
    readonly aggregateRoots: ReadonlyArray<string>;
    readonly childEntities: ReadonlyArray<string>;
    readonly aggregatePathPatterns: ReadonlyArray<string>;
  }>,
];
type MessageIds = "nonAggregateRepository";

const hasRepoSuffix = (name: string) =>
  name.endsWith("Repository") || name.endsWith("Repo");

const getPropCallSigs = (prop: ts.Symbol, checker: ts.TypeChecker) =>
  pipe(
    O.fromNullable(prop.valueDeclaration ?? prop.declarations?.[0]),
    O.map((d) => checker.getTypeOfSymbolAtLocation(prop, d).getCallSignatures()),
    O.getOrElse(() => [] as ReadonlyArray<ts.Signature>),
  );

const resolveDeclTypes = (param: ts.Symbol, checker: ts.TypeChecker) => (decl: ts.Declaration) =>
  pipe(checker.getTypeOfSymbolAtLocation(param, decl), (t) => unwrapContainerTsTypes(t, checker));

const resolveSingleParamTypes = (checker: ts.TypeChecker) => (p: ts.Symbol) =>
  pipe(
    O.fromNullable(p.valueDeclaration ?? p.declarations?.[0]),
    O.map(resolveDeclTypes(p, checker)),
    O.getOrElse(() => [] as ReadonlyArray<ts.Type>),
  );

const getParamTypesFromSig = (sig: ts.Signature, checker: ts.TypeChecker) =>
  pipe(
    sig.getParameters(),
    RA.flatMap(resolveSingleParamTypes(checker)),
  );

const extractEntityNamesFromDecl = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  return pipe(
    services.esTreeNodeToTSNodeMap.get(node),
    (tsNode) => checker.getTypeAtLocation(tsNode).getProperties(),
    RA.flatMap((prop) => getPropCallSigs(prop, checker)),
    RA.flatMap((sig) => [
      ...unwrapContainerTsTypes(checker.getReturnTypeOfSignature(sig), checker),
      ...getParamTypesFromSig(sig, checker),
    ]),
    RA.filterMap(getTsTypeName),
    RA.uniq(S.Eq),
  );
};

const resolveManagedEntities = (
  reportNode: TSESTree.Node,
  repoName: string,
  graph: ReturnType<typeof analyzeAggregateGraph>,
  services: ParserServicesWithTypeInformation,
) =>
  pipe(
    graph.repos,
    RA.findFirst((r) => r.repoName === repoName),
    O.map((r) => r.entityTypes),
    O.getOrElse(() => extractEntityNamesFromDecl(reportNode, services)),
  );

const resolveChildEntityInfo = (
  entity: string,
  childSet: ReadonlySet<string>,
  graph: ReturnType<typeof analyzeAggregateGraph>,
) =>
  childSet.has(entity)
    ? O.some({ entity, parent: "parent Aggregate Root" })
    : pipe(graph.isChildEntity(entity), O.map((parents) => ({ entity, parent: parents.join(", ") })));

const findNonAggregateWithSets = (
  managedEntities: ReadonlyArray<string>,
  childSet: ReadonlySet<string>,
  explicitAggs: ReadonlySet<string>,
  graph: ReturnType<typeof analyzeAggregateGraph>,
) =>
  pipe(
    managedEntities,
    RA.filter((entity) => !explicitAggs.has(entity)),
    RA.filterMap((entity) => resolveChildEntityInfo(entity, childSet, graph)),
    RA.head,
  );

const findNonAggregateTarget = (
  managedEntities: ReadonlyArray<string>,
  options: Options[0],
  graph: ReturnType<typeof analyzeAggregateGraph>,
) =>
  findNonAggregateWithSets(
    managedEntities,
    new Set(options.childEntities),
    new Set(options.aggregateRoots),
    graph,
  );

const checkRepoDeclaration = (
  reportNode: TSESTree.Node,
  repoName: string,
  options: Options[0],
  graph: ReturnType<typeof analyzeAggregateGraph>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(hasRepoSuffix(repoName))
    .with(false, () => {})
    .with(true, () => {
      pipe(
        findNonAggregateTarget(resolveManagedEntities(reportNode, repoName, graph, services), options, graph),
        O.map(({ entity, parent }) => {
          report({ node: reportNode, messageId: "nonAggregateRepository", data: { repo: repoName, entity, parent } });
        }),
      );
    })
    .exhaustive();
};

const makeRepoNodeChecker =
  (
    options: Options[0],
    services: ParserServicesWithTypeInformation,
    report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
  ) =>
  (node: TSESTree.Node, name: O.Option<string>) => {
    pipe(
      name,
      O.map((n) => {
        checkRepoDeclaration(
          node,
          n,
          options,
          analyzeAggregateGraph(services.program, options.aggregateRoots, options.aggregatePathPatterns),
          services,
          report,
        );
      }),
    );
  };

const createRepoListeners = (
  options: Options[0],
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  const check = makeRepoNodeChecker(options, services, report);
  return {
    TSTypeAliasDeclaration: (node: TSESTree.TSTypeAliasDeclaration) => { check(node, O.some(node.id.name)); },
    TSInterfaceDeclaration: (node: TSESTree.TSInterfaceDeclaration) => { check(node, O.some(node.id.name)); },
    ClassDeclaration: (node: TSESTree.ClassDeclaration) => { check(node, O.fromNullable(node.id?.name)); },
    VariableDeclarator: (node: TSESTree.VariableDeclarator) => {
      check(node, node.id.type === AST_NODE_TYPES.Identifier ? O.some(node.id.name) : O.none);
    },
  };
};

export const repositoryAggregateRootOnly = createRule<Options, MessageIds>({
  name: "repository-aggregate-root-only",
  meta: {
    type: "problem",
    docs: {
      description:
        "Allow repositories only for Aggregate Roots; flag repositories targeting child entities owned by another Aggregate.",
    },
    messages: {
      nonAggregateRepository:
        "Repository `{{repo}}` targets child entity `{{entity}}` (owned by `{{parent}}`). Repositories are only allowed for Aggregate Roots.",
    },
    schema: [
      {
        type: "object",
        properties: {
          aggregateRoots: { type: "array", items: { type: "string" } },
          childEntities: { type: "array", items: { type: "string" } },
          aggregatePathPatterns: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        aggregateRoots: [],
        childEntities: [],
        aggregatePathPatterns: ["**/aggregates/**", "**/aggregate/**"],
      },
    ],
  },
  create: (context, [options]) =>
    createRepoListeners(options, ESLintUtils.getParserServices(context), (d) => { context.report(d); }),
});
