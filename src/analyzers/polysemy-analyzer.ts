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

const buildModelDefIfLarge = (
  node: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration,
  name: string,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
) => {
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

const extractModelDef = (node: ts.Node, sf: ts.SourceFile, checker: ts.TypeChecker) =>
  isModelDeclaration(node) && node.name
    ? buildModelDefIfLarge(node, node.name.text, sf, checker)
    : O.none;

const resolveModelKeyForType = (type: ts.Type) =>
  flow(
    () => O.Do,
    O.apS("name", resolveTsTypeName(type)),
    O.apS("file", resolveTsTypeDeclarationFile(type)),
    O.map(({ file, name }) => makeModelKey(file, name)),
  )();

const isIgnoredReceiver = (expr: ts.Expression) =>
  ts.isIdentifier(expr) && IGNORED_RECEIVER_NAMES.has(expr.text);

type EdgeExtractionContext = Readonly<{
  readonly candidateFieldNames: ReadonlySet<string>;
  readonly models: Readonly<Record<string, ModelDef>>;
  readonly checker: ts.TypeChecker;
}>;

const hasModelField = (
  models: Readonly<Record<string, ModelDef>>,
  modelKey: string,
  fieldName: string,
) => O.exists((m: ModelDef) => m.fields.has(fieldName))(RR.lookup(modelKey, models));

const extractPropAccessEdge = (
  node: ts.PropertyAccessExpression,
  modulePath: string,
  { candidateFieldNames, models, checker }: EdgeExtractionContext,
) =>
  candidateFieldNames.has(node.name.text) && !isIgnoredReceiver(node.expression)
    ? flow(
        resolveModelKeyForType,
        O.filter((modelKey) => hasModelField(models, modelKey, node.name.text)),
        O.map((modelKey) => ({ modelKey, modulePath, field: node.name.text })),
      )(checker.getTypeAtLocation(node.expression))
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

const mapModelFieldsToEdges = (
  model: ModelDef,
  fields: ReadonlyArray<string>,
  modulePath: string,
) => RA.filterMap(toModelFieldEdge(model, modulePath))(fields);

const resolveBindingEdgesForFields = (
  pattern: ts.ObjectBindingPattern,
  fields: ReadonlyArray<string>,
  modulePath: string,
  { models, checker }: EdgeExtractionContext,
) =>
  flow(
    resolveModelKeyForType,
    O.flatMap((modelKey) => RR.lookup(modelKey, models)),
    O.match(
      () => [] as ReadonlyArray<AccessEdge>,
      (model) => mapModelFieldsToEdges(model, fields, modulePath),
    ),
  )(checker.getTypeAtLocation(pattern));

const extractBindingEdges = (
  pattern: ts.ObjectBindingPattern,
  modulePath: string,
  ctx: EdgeExtractionContext,
) => {
  const fields = flow(
    RA.filterMap(resolveBindingFieldName),
    RA.filter((f) => ctx.candidateFieldNames.has(f)),
  )(pattern.elements);
  return fields.length === 0
    ? ([] as ReadonlyArray<AccessEdge>)
    : resolveBindingEdgesForFields(pattern, fields, modulePath, ctx);
};

const extractFilePropAccessEdges = (
  nodes: ReadonlyArray<ts.Node>,
  modulePath: string,
  ctx: EdgeExtractionContext,
) =>
  flow(
    RA.filter(ts.isPropertyAccessExpression),
    RA.filterMap((n) => extractPropAccessEdge(n, modulePath, ctx)),
  )(nodes);

const extractFileBindingEdges = (
  nodes: ReadonlyArray<ts.Node>,
  modulePath: string,
  ctx: EdgeExtractionContext,
) =>
  flow(
    RA.filter(ts.isObjectBindingPattern),
    RA.flatMap((n) => extractBindingEdges(n, modulePath, ctx)),
  )(nodes);

const extractEdgesFromFile = (ctx: EdgeExtractionContext) => (sf: ts.SourceFile) => {
  const nodes = collectTsNodes(sf, sf);
  const modulePath = normalizeFilePath(sf.fileName);
  return [
    ...extractFilePropAccessEdges(nodes, modulePath, ctx),
    ...extractFileBindingEdges(nodes, modulePath, ctx),
  ];
};

const collectFileNodes = (sf: ts.SourceFile) => collectTsNodes(sf, sf);

const extractFileModels = (checker: ts.TypeChecker) => (sf: ts.SourceFile) =>
  flow(
    collectFileNodes,
    RA.filterMap((n) => extractModelDef(n, sf, checker)),
  )(sf);

const indexModelsByKey = flow(
  RA.map((m: ModelDef) => [m.modelKey, m] as const),
  RR.fromEntries,
);

const collectModelsFromFiles = (files: ReadonlyArray<ts.SourceFile>, checker: ts.TypeChecker) =>
  flow(RA.flatMap(extractFileModels(checker)), indexModelsByKey)(files);

const collectCandidateFieldNames = (models: Readonly<Record<string, ModelDef>>) =>
  new Set(
    RA.flatMap(([, m]: readonly [string, ModelDef]) => Array.from(m.fields))(RR.toEntries(models)),
  );

const collectEdgesByModel = (
  files: ReadonlyArray<ts.SourceFile>,
  models: Readonly<Record<string, ModelDef>>,
  checker: ts.TypeChecker,
) =>
  flow(
    RA.flatMap(
      extractEdgesFromFile({
        candidateFieldNames: collectCandidateFieldNames(models),
        models,
        checker,
      }),
    ),
    RNEA.groupBy((edge) => edge.modelKey),
  )(files);

const collectProgramPolysemyGraph = (program: ts.Program) => {
  const checker = program.getTypeChecker();
  const files = collectProjectSourceFiles(program);
  const models = collectModelsFromFiles(files, checker);
  return {
    models,
    edgesByModel: collectEdgesByModel(files, models, checker),
  };
};

const resolveProgramPolysemyGraph = (program: ts.Program) =>
  memoizeByProgram(program, polysemyCache, collectProgramPolysemyGraph);

const countSharedFields = (a: ReadonlyArray<string>, setB: ReadonlySet<string>) =>
  RA.filter((x: string) => setB.has(x))(a).length;

const computeJaccard = (a: ReadonlyArray<string>, b: ReadonlyArray<string>, unionSize: number) =>
  unionSize === 0 ? 1 : countSharedFields(a, new Set(b)) / unionSize;

const jaccardSimilarity = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  computeJaccard(a, b, new Set([...a, ...b]).size);

type IndexedCluster = Readonly<Record<"idx", number> & { readonly cluster: ModuleFieldUsage }>;

const hasLaterLowOverlap = (
  indexed: ReadonlyArray<IndexedCluster>,
  idx1: number,
  c1: ModuleFieldUsage,
  maxOverlap: number,
) =>
  RA.some(
    ({ idx: idx2, cluster: c2 }: IndexedCluster) =>
      idx2 > idx1 && jaccardSimilarity(c1.fields, c2.fields) <= maxOverlap,
  )(indexed);

const hasOverlapBelow = (indexed: ReadonlyArray<IndexedCluster>, maxOverlap: number) =>
  RA.some(({ idx: idx1, cluster: c1 }: IndexedCluster) =>
    hasLaterLowOverlap(indexed, idx1, c1, maxOverlap),
  )(indexed);

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

const groupEdgesByModule = ({ edges, model }: ModelEdgeGroup) =>
  flow(
    RA.filter((e: AccessEdge) => model.fields.has(e.field)),
    RNEA.groupBy((e) => e.modulePath),
    RR.toEntries,
    RA.map(toModuleFieldUsage),
  )(edges);

type PolysemyThresholds = Readonly<Record<"minFields" | "minClusterFields" | "maxOverlap", number>>;

const collectQualifiedClusters = (group: ModelEdgeGroup, minClusterFields: number) =>
  flow(
    groupEdgesByModule,
    RA.filter((c) => c.fields.length >= minClusterFields),
  )(group);

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

const extractPolysemyFindings =
  (thresholds: PolysemyThresholds) => (graph: ProgramPolysemyGraph) =>
    flow(
      readModelEntries,
      RA.filterMap(([, model]) =>
        toPolysemyFinding({ model, edges: graph.edgesByModel[model.modelKey] ?? [] }, thresholds),
      ),
    )(graph);

const computePolysemyIndex = (program: ts.Program, thresholds: PolysemyThresholds) =>
  flow(
    resolveProgramPolysemyGraph,
    extractPolysemyFindings(thresholds),
    indexPolysemyFindings,
  )(program);

const makePolysemyCacheKey = (
  minFields: number,
  minClusterFields: number,
  maxOverlap: number,
) => `${String(minFields)}:${String(minClusterFields)}:${String(maxOverlap)}`;

export const analyzePolysemy = (
  program: ts.Program,
  minFields = 4,
  minClusterFields = 2,
  maxOverlap = 0.2,
) =>
  memoizeByProgramAndKey(
    program,
    makePolysemyCacheKey(minFields, minClusterFields, maxOverlap),
    polysemyIndexCache,
    (p) => computePolysemyIndex(p, { minFields, minClusterFields, maxOverlap }),
  );
