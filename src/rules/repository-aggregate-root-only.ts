import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { analyzeAggregateGraph } from "../analyzers/aggregate-graph-analyzer.js";
import { lazyOnce } from "../lib/lazy-once.js";
import { createRule } from "../lib/rule-factory.js";
import { unwrapContainerTsTypes } from "../lib/ts-container-types.js";
import { resolveTsTypeName } from "../lib/ts-type-name.js";

type Options = [
  Readonly<{
    readonly aggregateRoots: ReadonlyArray<string>;
    readonly childEntities: ReadonlyArray<string>;
    readonly aggregatePathPatterns: ReadonlyArray<string>;
  }>,
];
type MessageIds = "nonAggregateRepository";
type AggregateGraph = ReturnType<typeof analyzeAggregateGraph>;

const hasRepoSuffix = (name: string) =>
  name.endsWith("Repository") || name.endsWith("Repo");

const extractSymbolDeclaration = (sym: ts.Symbol) =>
  O.fromNullable(sym.valueDeclaration ?? sym.declarations?.[0]);

const resolvePropCallSigs = (prop: ts.Symbol, checker: ts.TypeChecker) => {
  const resolve = flow(
    extractSymbolDeclaration,
    O.map((d: ts.Declaration) => checker.getTypeOfSymbolAtLocation(prop, d).getCallSignatures()),
    O.getOrElse<ReadonlyArray<ts.Signature>>(() => []),
  );
  return resolve(prop);
};

const resolveDeclTypes = (param: ts.Symbol, checker: ts.TypeChecker) =>
  flow(
    (decl: ts.Declaration) => checker.getTypeOfSymbolAtLocation(param, decl),
    (t) => unwrapContainerTsTypes(t, checker),
  );

const resolveSingleParamTypes = (checker: ts.TypeChecker) => (p: ts.Symbol) => {
  const resolve = flow(
    extractSymbolDeclaration,
    O.map(resolveDeclTypes(p, checker)),
    O.getOrElse<ReadonlyArray<ts.Type>>(() => []),
  );
  return resolve(p);
};

const extractParamTypesFromSig = (sig: ts.Signature, checker: ts.TypeChecker) =>
  RA.flatMap(resolveSingleParamTypes(checker))(sig.getParameters());

const extractEntityNamesFromDecl = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  const extract = flow(
    (n: TSESTree.Node) => services.esTreeNodeToTSNodeMap.get(n),
    (tsNode: ts.Node) => checker.getTypeAtLocation(tsNode).getProperties(),
    RA.flatMap((prop) => resolvePropCallSigs(prop, checker)),
    RA.flatMap((sig) => [
      ...unwrapContainerTsTypes(checker.getReturnTypeOfSignature(sig), checker),
      ...extractParamTypesFromSig(sig, checker),
    ]),
    RA.filterMap(resolveTsTypeName),
    RA.uniq(S.Eq),
  );
  return extract(node);
};

const resolveManagedEntities =
  (graph: AggregateGraph, services: ParserServicesWithTypeInformation) =>
  (reportNode: TSESTree.Node, repoName: string) => {
    const resolve = flow(
      RA.findFirst((r: AggregateGraph["repos"][number]) => r.repoName === repoName),
      O.map((r) => r.entityTypes),
      O.getOrElse(() => extractEntityNamesFromDecl(reportNode, services)),
    );
    return resolve(graph.repos);
  };

const joinParentNames = (parents: ReadonlyArray<string>) => parents.join(", ");

const resolveChildOwnership =
  (childSet: ReadonlySet<string>, graph: AggregateGraph) => (entity: string) =>
    childSet.has(entity)
      ? O.some({ entity, parent: "parent Aggregate Root" })
      : O.map((parents: ReadonlyArray<string>) => ({ entity, parent: joinParentNames(parents) }))(
          graph.isChildEntity(entity),
        );

const excludeExplicitAggregates = (explicitAggs: ReadonlySet<string>) =>
  RA.filter((entity: string) => !explicitAggs.has(entity));

const findNonAggregateTarget =
  (options: Options[0], graph: AggregateGraph) =>
  (managedEntities: ReadonlyArray<string>) => {
    const find = flow(
      excludeExplicitAggregates(new Set(options.aggregateRoots)),
      RA.filterMap(resolveChildOwnership(new Set(options.childEntities), graph)),
      RA.head,
    );
    return find(managedEntities);
  };

const checkRepoDeclaration =
  (
    options: Options[0],
    graph: AggregateGraph,
  ) =>
  (
    services: ParserServicesWithTypeInformation,
    report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
  ) =>
  (reportNode: TSESTree.Node, repoName: string) => {
    match(hasRepoSuffix(repoName))
      .with(false, () => {})
      .with(true, () => {
        const check = flow(
          (n: TSESTree.Node) => resolveManagedEntities(graph, services)(n, repoName),
          findNonAggregateTarget(options, graph),
          O.map(({ entity, parent }) => {
            report({ node: reportNode, messageId: "nonAggregateRepository", data: { repo: repoName, entity, parent } });
          }),
        );
        check(reportNode);
      })
      .exhaustive();
  };

const resolveRepoAggregateGraph = (
  options: Options[0],
  services: ParserServicesWithTypeInformation,
) =>
  analyzeAggregateGraph(services.program, {
    explicitOptionRoots: options.aggregateRoots,
    aggregatePathPatterns: options.aggregatePathPatterns,
  });

const buildRepoListeners =
  (options: Options[0], services: ParserServicesWithTypeInformation) =>
  (report: (d: TSESLint.ReportDescriptor<MessageIds>) => void) => {
    const getGraph = flow(lazyOnce(() => resolveRepoAggregateGraph(options, services)));
    const check = (node: TSESTree.Node, name: O.Option<string>) => {
      O.map((n: string) => {
        checkRepoDeclaration(options, getGraph())(services, report)(node, n);
      })(O.filter(hasRepoSuffix)(name));
    };
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
    buildRepoListeners(options, ESLintUtils.getParserServices(context))((d) => { context.report(d); }),
});
