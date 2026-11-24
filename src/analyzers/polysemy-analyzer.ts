import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { memoizeByProgram, memoizeByProgramAndKey } from "../lib/program-memo.js";
import { collectProjectSourceFiles, normalizeFilePath } from "../lib/source-paths.js";
import { TsLocation, makeLocationKey, resolveTsNodeLocation } from "../lib/ts-node-location.js";
import { collectTsNodes } from "../lib/ts-node-traversal.js";
import { resolveTsTypeDeclarationFile } from "../lib/ts-type-declaration.js";
import { resolveTsTypeName } from "../lib/ts-type-name.js";

export type ModuleFieldUsage = Readonly<
  Record<"modulePath", string> & {
    readonly fields: ReadonlyArray<string>;
  }
>;

export type PolysemyFinding = Readonly<
  Record<"modelKey" | "modelName", string> & {
    readonly location: TsLocation;
    readonly clusters: ReadonlyArray<ModuleFieldUsage>;
  }
>;

type ModelDef = Readonly<
  Record<"modelKey" | "modelName", string> & {
    readonly location: TsLocation;
    readonly fields: ReadonlySet<string>;
  }
>;

type AccessEdge = Readonly<Record<"modelKey" | "modulePath" | "field", string>>;

type ProgramPolysemyGraph = Readonly<{
  readonly models: Readonly<Record<string, ModelDef>>;
  readonly edgesByModel: Readonly<Record<string, ReadonlyArray<AccessEdge>>>;
}>;

const polysemyCache = new WeakMap<ts.Program, ProgramPolysemyGraph>();

const IGNORED_MODEL_FIELDS: ReadonlySet<string> = new Set(["kind", "type", "_tag", "tag", "URI", "_A"]);
const IGNORED_RECEIVER_NAMES: ReadonlySet<string> = new Set([
  "O",
  "RA",
  "R",
  "S",
  "P",
  "NEA",
  "ts",
  "path",
  "AST_NODE_TYPES",
]);

const formatModelKey = (normalizedPath: string, name: string) => `${normalizedPath}#${name}`;

const makeModelKey = (filePath: string, name: string) =>
  formatModelKey(normalizeFilePath(filePath), name);

const extractPropNames = flow(
  (type: ts.Type) => type.getProperties(),
  RA.map((p) => p.name),
  RA.filter((name) => !IGNORED_MODEL_FIELDS.has(name)),
  RA.uniq(S.Eq),
);

const isModelDeclaration = (
  node: ts.Node,
): node is ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration =>
  ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node);

const buildModelDefIfLarge =
  (checker: ts.TypeChecker) =>
  (
    node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration,
    sf: ts.SourceFile,
  ) => {
    const name = node.name?.text ?? "";
    const props = extractPropNames(checker.getTypeAtLocation(node));
    return props.length >= 4
      ? O.some<ModelDef>({
          modelKey: makeModelKey(sf.fileName, name),
          modelName: name,
          location: resolveTsNodeLocation(node, sf),
          fields: new Set(props),
        })
      : O.none;
  };

const extractModelDef =
  (checker: ts.TypeChecker) => (node: ts.Node, sf: ts.SourceFile) =>
    isModelDeclaration(node) && node.name
      ? buildModelDefIfLarge(checker)(node, sf)
      : O.none;

const resolveModelKeyForType = (type: ts.Type) => {
  const nameOpt = resolveTsTypeName(type);
  const fileOpt = resolveTsTypeDeclarationFile(type);
  return O.isSome(nameOpt) && O.isSome(fileOpt)
    ? O.some(makeModelKey(fileOpt.value, nameOpt.value))
    : O.none;
};

const isIgnoredReceiver = (expr: ts.Expression) =>
  ts.isIdentifier(expr) && IGNORED_RECEIVER_NAMES.has(expr.text);

type EdgeExtractionContext = Readonly<{
  readonly candidateFieldNames: ReadonlySet<string>;
  readonly models: Readonly<Record<string, ModelDef>>;
  readonly checker: ts.TypeChecker;
}>;

const hasModelField = (
  models: Readonly<Record<string, ModelDef>>,
  { modelKey, fieldName }: Readonly<Record<"modelKey" | "fieldName", string>>,
) => O.exists((m: ModelDef) => m.fields.has(fieldName))(RR.lookup(modelKey, models));

const resolveMatchingModelEdge =
  (models: Readonly<Record<string, ModelDef>>) => (modulePath: string, fieldName: string) =>
    flow(
      resolveModelKeyForType,
      O.filter((modelKey: string) => hasModelField(models, { modelKey, fieldName })),
      O.map((modelKey: string) => ({ modelKey, modulePath, field: fieldName })),
    );

const extractPropAccessEdge =
  ({ candidateFieldNames, models, checker }: EdgeExtractionContext) =>
  (node: ts.PropertyAccessExpression, modulePath: string) =>
    candidateFieldNames.has(node.name.text) && !isIgnoredReceiver(node.expression)
      ? resolveMatchingModelEdge(models)(modulePath, node.name.text)(
          checker.getTypeAtLocation(node.expression),
        )
      : O.none;

const resolveExplicitBindingName = (propName: ts.PropertyName) =>
  ts.isIdentifier(propName) ? O.some(propName.text) : O.none;

const resolveBindingIdentifierName = (name: ts.BindingName) =>
  ts.isIdentifier(name) ? O.some(name.text) : O.none;

const resolveBindingFieldName = (el: ts.BindingElement) =>
  el.propertyName
    ? resolveExplicitBindingName(el.propertyName)
    : resolveBindingIdentifierName(el.name);

const toModelFieldEdge = (model: ModelDef, modulePath: string) => (field: string) =>
  model.fields.has(field) ? O.some({ modelKey: model.modelKey, modulePath, field }) : O.none;

type BindingEdgeTarget = Readonly<
  Record<"modulePath", string> & {
    readonly fields: ReadonlyArray<string>;
  }
>;

const mapModelFieldsToEdges = (
  model: ModelDef,
  { fields, modulePath }: BindingEdgeTarget,
) => RA.filterMap(toModelFieldEdge(model, modulePath))(fields);

const resolveEdgesForModelKey = (
  target: BindingEdgeTarget,
  models: Readonly<Record<string, ModelDef>>,
) =>
  flow(
    resolveModelKeyForType,
    O.flatMap((modelKey: string) => RR.lookup(modelKey, models)),
    O.match(
      () => [] satisfies ReadonlyArray<AccessEdge>,
      (model: ModelDef) => mapModelFieldsToEdges(model, target),
    ),
  );

const resolveBindingEdgesForFields =
  ({ models, checker }: EdgeExtractionContext) =>
  (pattern: ts.ObjectBindingPattern, target: BindingEdgeTarget) =>
    resolveEdgesForModelKey(target, models)(checker.getTypeAtLocation(pattern));

const extractBindingEdges =
  (ctx: EdgeExtractionContext) => (pattern: ts.ObjectBindingPattern, modulePath: string) => {
    const fields = RA.filter((f: string) => ctx.candidateFieldNames.has(f))(
      RA.filterMap(resolveBindingFieldName)(pattern.elements),
    );
    return fields.length === 0
      ? ([] satisfies ReadonlyArray<AccessEdge>)
      : resolveBindingEdgesForFields(ctx)(pattern, { fields, modulePath });
  };

const extractFilePropAccessEdges =
  (ctx: EdgeExtractionContext) => (nodes: ReadonlyArray<ts.Node>, modulePath: string) =>
    RA.filterMap((n: ts.PropertyAccessExpression) => extractPropAccessEdge(ctx)(n, modulePath))(
      RA.filter(ts.isPropertyAccessExpression)(nodes),
    );

const extractFileBindingEdges =
  (ctx: EdgeExtractionContext) => (nodes: ReadonlyArray<ts.Node>, modulePath: string) =>
    RA.flatMap((n: ts.ObjectBindingPattern) => extractBindingEdges(ctx)(n, modulePath))(
      RA.filter(ts.isObjectBindingPattern)(nodes),
    );

const extractEdgesFromFile = (ctx: EdgeExtractionContext) => (sf: ts.SourceFile) => {
  const nodes = collectTsNodes(sf, sf);
  const modulePath = normalizeFilePath(sf.fileName);
  return [
    ...extractFilePropAccessEdges(ctx)(nodes, modulePath),
    ...extractFileBindingEdges(ctx)(nodes, modulePath),
  ];
};

const collectFileNodes = (sf: ts.SourceFile) => collectTsNodes(sf, sf);

const extractFileModels = (checker: ts.TypeChecker) =>
  flow(
    (sf: ts.SourceFile) => ({ sf, nodes: collectFileNodes(sf) }),
    ({ sf, nodes }) => RA.filterMap((n: ts.Node) => extractModelDef(checker)(n, sf))(nodes),
  );

const indexModelsByKey = flow(
  RA.map((m: ModelDef) => [m.modelKey, m] as const),
  RR.fromEntries,
);

const collectModelsFromFiles = (files: ReadonlyArray<ts.SourceFile>, checker: ts.TypeChecker) =>
  indexModelsByKey(RA.flatMap(extractFileModels(checker))(files));

const collectCandidateFieldNames = (models: Readonly<Record<string, ModelDef>>) =>
  new Set(
    RA.flatMap(([, m]: readonly [string, ModelDef]) => Array.from(m.fields))(RR.toEntries(models)),
  );

const collectEdgesByModel =
  (checker: ts.TypeChecker) =>
  (files: ReadonlyArray<ts.SourceFile>, models: Readonly<Record<string, ModelDef>>) =>
    RNEA.groupBy((edge: AccessEdge) => edge.modelKey)(
      RA.flatMap(
        extractEdgesFromFile({
          candidateFieldNames: collectCandidateFieldNames(models),
          models,
          checker,
        }),
      )(files),
    );

const collectProgramPolysemyGraph = (program: ts.Program) => {
  const checker = program.getTypeChecker();
  const files = collectProjectSourceFiles(program);
  const models = collectModelsFromFiles(files, checker);
  return {
    models,
    edgesByModel: collectEdgesByModel(checker)(files, models),
  };
};

const resolveProgramPolysemyGraph = memoizeByProgram(polysemyCache, collectProgramPolysemyGraph);

const countSharedFields = (a: ReadonlyArray<string>, setB: ReadonlySet<string>) =>
  RA.filter((x: string) => setB.has(x))(a).length;

const jaccardSimilarity = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  const unionSize = new Set([...a, ...b]).size;
  return unionSize === 0 ? 1 : countSharedFields(a, new Set(b)) / unionSize;
};

type IndexedCluster = Readonly<Record<"idx", number> & { readonly cluster: ModuleFieldUsage }>;

const hasLaterLowOverlap = (
  { idx: idx1, cluster: c1 }: IndexedCluster,
  {
    indexed,
    maxOverlap,
  }: Readonly<Record<"maxOverlap", number> & { readonly indexed: ReadonlyArray<IndexedCluster> }>,
) =>
  RA.some(
    ({ idx: idx2, cluster: c2 }: IndexedCluster) =>
      idx2 > idx1 && jaccardSimilarity(c1.fields, c2.fields) <= maxOverlap,
  )(indexed);

const hasOverlapBelow = (indexed: ReadonlyArray<IndexedCluster>, maxOverlap: number) =>
  RA.some((entry: IndexedCluster) => hasLaterLowOverlap(entry, { indexed, maxOverlap }))(indexed);

const hasDisjointPair = (clusters: ReadonlyArray<ModuleFieldUsage>, maxOverlap: number) =>
  hasOverlapBelow(
    RA.mapWithIndex((idx, cluster: ModuleFieldUsage) => ({ idx, cluster }))(clusters),
    maxOverlap,
  );

const extractSortedModuleFields = flow(
  RA.map((e: AccessEdge) => e.field),
  RA.uniq(S.Eq),
  RA.sort(S.Ord),
);

const toModuleFieldUsage = ([modulePath, moduleEdges]: readonly [
  string,
  ReadonlyArray<AccessEdge>,
]) => ({
  modulePath,
  fields: extractSortedModuleFields(moduleEdges),
});

type ModelEdgeGroup = Readonly<{
  readonly model: ModelDef;
  readonly edges: ReadonlyArray<AccessEdge>;
}>;

const buildModuleFieldUsages = (model: ModelDef) =>
  flow(
    RA.filter((e: AccessEdge) => model.fields.has(e.field)),
    RNEA.groupBy((e: AccessEdge) => e.modulePath),
    RR.toEntries,
    RA.map(toModuleFieldUsage),
  );

const groupEdgesByModule = ({ edges, model }: ModelEdgeGroup) =>
  buildModuleFieldUsages(model)(edges);

type PolysemyThresholds = Readonly<Record<"minFields" | "minClusterFields" | "maxOverlap", number>>;

const collectQualifiedClusters = (group: ModelEdgeGroup, minClusterFields: number) =>
  RA.filter((c: ModuleFieldUsage) => c.fields.length >= minClusterFields)(
    groupEdgesByModule(group),
  );

const findDisjointModelFinding = (
  group: ModelEdgeGroup,
  { minClusterFields, maxOverlap }: PolysemyThresholds,
) => {
  const clusters = collectQualifiedClusters(group, minClusterFields);
  return clusters.length >= 2 && hasDisjointPair(clusters, maxOverlap)
    ? O.some<PolysemyFinding>({
        modelKey: group.model.modelKey,
        modelName: group.model.modelName,
        location: group.model.location,
        clusters,
      })
    : O.none;
};

const toPolysemyFinding = (group: ModelEdgeGroup, thresholds: PolysemyThresholds) => {
  const { model } = group;
  return model.fields.size < thresholds.minFields
    ? O.none
    : findDisjointModelFinding(group, thresholds);
};

const indexFindingsRecord = flow(
  RA.map((f: PolysemyFinding) => [makeLocationKey(f.location), f] as const),
  RR.fromEntries,
);

const indexPolysemyFindings = (findings: ReadonlyArray<PolysemyFinding>) => ({
  findings,
  byLocation: indexFindingsRecord(findings),
});

type PolysemyIndex = Readonly<{
  readonly findings: ReadonlyArray<PolysemyFinding>;
  readonly byLocation: Readonly<Record<string, PolysemyFinding>>;
}>;

const polysemyIndexCache = new WeakMap<ts.Program, Readonly<Record<string, PolysemyIndex>>>();

const readModelEntries = (graph: ProgramPolysemyGraph) => RR.toEntries(graph.models);

const extractPolysemyFindings = (thresholds: PolysemyThresholds) =>
  flow(
    (graph: ProgramPolysemyGraph) => ({ graph, entries: readModelEntries(graph) }),
    ({ graph, entries }) =>
      RA.filterMap(([, model]: readonly [string, ModelDef]) =>
        toPolysemyFinding({ model, edges: graph.edgesByModel[model.modelKey] ?? [] }, thresholds),
      )(entries),
  );

const computePolysemyIndexForThresholds = (thresholds: PolysemyThresholds) =>
  flow(resolveProgramPolysemyGraph, extractPolysemyFindings(thresholds), indexPolysemyFindings);

const DEFAULT_POLYSEMY_THRESHOLDS: PolysemyThresholds = {
  minFields: 4,
  minClusterFields: 2,
  maxOverlap: 0.2,
};

const makePolysemyCacheKey = (thresholds: PolysemyThresholds) =>
  `${String(thresholds.minFields)}:${String(thresholds.minClusterFields)}:${String(thresholds.maxOverlap)}`;

export const analyzePolysemy = (
  program: ts.Program,
  thresholds: Partial<PolysemyThresholds> = {},
): PolysemyIndex => {
  const resolved: PolysemyThresholds = { ...DEFAULT_POLYSEMY_THRESHOLDS, ...thresholds };
  return memoizeByProgramAndKey(
    polysemyIndexCache,
    computePolysemyIndexForThresholds(resolved),
  )(program, makePolysemyCacheKey(resolved));
};
