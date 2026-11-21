import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as R from "fp-ts/lib/Record.js";
import * as S from "fp-ts/lib/string.js";
import { pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { getProjectSourceFiles, memoizeByProgram, memoizeByProgramAndKey, normalizeFilePath } from "../utils/program-cache.js";
import {
  collectTsNodes,
  getTsNodeLocation,
  makeLocationKey,
  TsLocation,
} from "../utils/ts-ast-helpers.js";
import { getTsTypeDeclarationFile, getTsTypeName } from "../utils/type-helpers.js";

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

type ProgramPolysemyData = Readonly<{
  readonly models: Readonly<Record<string, ModelDef>>;
  readonly edgesByModel: Readonly<Record<string, ReadonlyArray<AccessEdge>>>;
}>;

const polysemyCache = new WeakMap<ts.Program, ProgramPolysemyData>();

const IGNORED_MODEL_FIELDS = new Set(["kind", "type", "_tag", "tag", "URI", "_A"]);
const IGNORED_RECEIVER_NAMES = new Set(["O", "RA", "R", "S", "P", "NEA", "ts", "path", "AST_NODE_TYPES"]);

const makeModelKey = (filePath: string, name: string) =>
  `${normalizeFilePath(filePath)}#${name}`;

const extractPropNames = (type: ts.Type) =>
  pipe(
    type.getProperties(),
    RA.map((p) => p.name),
    RA.filter((name) => !IGNORED_MODEL_FIELDS.has(name)),
    RA.uniq(S.Eq),
  );

const isModelDeclaration = (
  node: ts.Node,
): node is ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration =>
  ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node);

const extractModelDef = (node: ts.Node, sf: ts.SourceFile, checker: ts.TypeChecker) =>
  isModelDeclaration(node) && node.name
    ? pipe(
        extractPropNames(checker.getTypeAtLocation(node)),
        (props) =>
          props.length >= 4 && node.name
            ? O.some<ModelDef>({
                modelKey: makeModelKey(sf.fileName, node.name.text),
                modelName: node.name.text,
                location: getTsNodeLocation(node, sf),
                fields: new Set(props),
              })
            : O.none,
      )
    : O.none;

const getModelKeyForType = (type: ts.Type) =>
  pipe(
    O.Do,
    O.apS("name", getTsTypeName(type)),
    O.apS("file", getTsTypeDeclarationFile(type)),
    O.map(({ file, name }) => makeModelKey(file, name)),
  );

const isIgnoredReceiver = (expr: ts.Expression) =>
  ts.isIdentifier(expr) && IGNORED_RECEIVER_NAMES.has(expr.text);

type EdgeExtractionContext = Readonly<{
  readonly candidateFieldNames: ReadonlySet<string>;
  readonly models: Readonly<Record<string, ModelDef>>;
  readonly checker: ts.TypeChecker;
}>;

const extractPropAccessEdge = (
  node: ts.PropertyAccessExpression,
  modulePath: string,
  { candidateFieldNames, models, checker }: EdgeExtractionContext,
) =>
  candidateFieldNames.has(node.name.text) && !isIgnoredReceiver(node.expression)
    ? pipe(
        getModelKeyForType(checker.getTypeAtLocation(node.expression)),
        O.filter((modelKey) => Boolean(models[modelKey]?.fields.has(node.name.text))),
        O.map((modelKey) => ({ modelKey, modulePath, field: node.name.text })),
      )
    : O.none;

const getExplicitBindingName = (propName: ts.PropertyName) =>
  ts.isIdentifier(propName) ? O.some(propName.text) : O.none;

const getBindingIdentifierName = (name: ts.BindingName) =>
  ts.isIdentifier(name) ? O.some(name.text) : O.none;

const getBindingFieldName = (el: ts.BindingElement) =>
  el.propertyName ? getExplicitBindingName(el.propertyName) : getBindingIdentifierName(el.name);

const mapModelFieldsToEdges = (
  model: ModelDef,
  fields: ReadonlyArray<string>,
  modulePath: string,
) =>
  pipe(
    fields,
    RA.filter((f) => model.fields.has(f)),
    RA.map((field) => ({ modelKey: model.modelKey, modulePath, field })),
  );

const resolveBindingEdgesForFields = (
  pattern: ts.ObjectBindingPattern,
  fields: ReadonlyArray<string>,
  modulePath: string,
  { models, checker }: EdgeExtractionContext,
) =>
  pipe(
    getModelKeyForType(checker.getTypeAtLocation(pattern)),
    O.flatMap((modelKey) => O.fromNullable(models[modelKey])),
    O.match(
      () => [] as ReadonlyArray<AccessEdge>,
      (model) => mapModelFieldsToEdges(model, fields, modulePath),
    ),
  );

const extractBindingEdges = (
  pattern: ts.ObjectBindingPattern,
  modulePath: string,
  ctx: EdgeExtractionContext,
) => {
  const fields = pipe(
    pattern.elements,
    RA.filterMap(getBindingFieldName),
    RA.filter((f) => ctx.candidateFieldNames.has(f)),
  );
  return fields.length === 0
    ? ([] as ReadonlyArray<AccessEdge>)
    : resolveBindingEdgesForFields(pattern, fields, modulePath, ctx);
};

const extractEdgesFromNodes = (
  nodes: ReadonlyArray<ts.Node>,
  modulePath: string,
  ctx: EdgeExtractionContext,
) => [
  ...pipe(
    nodes,
    RA.filter(ts.isPropertyAccessExpression),
    RA.filterMap((n) => extractPropAccessEdge(n, modulePath, ctx)),
  ),
  ...pipe(
    nodes,
    RA.filter(ts.isObjectBindingPattern),
    RA.flatMap((n) => extractBindingEdges(n, modulePath, ctx)),
  ),
];

const extractNodesWithPath =
  (modulePath: string, ctx: EdgeExtractionContext) => (nodes: ReadonlyArray<ts.Node>) =>
    extractEdgesFromNodes(nodes, modulePath, ctx);

const extractEdgesFromFile = (ctx: EdgeExtractionContext) => (sf: ts.SourceFile) =>
  pipe(collectTsNodes(sf, sf), extractNodesWithPath(normalizeFilePath(sf.fileName), ctx));

const collectModelsFromFiles = (files: ReadonlyArray<ts.SourceFile>, checker: ts.TypeChecker) =>
  pipe(
    files,
    RA.flatMap((sf) =>
      pipe(collectTsNodes(sf, sf), RA.filterMap((n) => extractModelDef(n, sf, checker))),
    ),
    RA.reduce({}, (acc: Readonly<Record<string, ModelDef>>, m) => ({ ...acc, [m.modelKey]: m })),
  );

const collectCandidateFieldNames = (models: Readonly<Record<string, ModelDef>>) =>
  new Set(
    pipe(
      R.toEntries(models),
      RA.flatMap(([, m]) => Array.from(m.fields)),
    ),
  );

const collectEdgesByModel = (
  files: ReadonlyArray<ts.SourceFile>,
  models: Readonly<Record<string, ModelDef>>,
  checker: ts.TypeChecker,
) =>
  pipe(
    files,
    RA.flatMap(
      extractEdgesFromFile({
        candidateFieldNames: collectCandidateFieldNames(models),
        models,
        checker,
      }),
    ),
    RNEA.groupBy((edge) => edge.modelKey),
  );

const collectProgramData = (program: ts.Program) => {
  const checker = program.getTypeChecker();
  const files = getProjectSourceFiles(program);
  const models = collectModelsFromFiles(files, checker);
  return {
    models,
    edgesByModel: collectEdgesByModel(files, models, checker),
  };
};

const getProgramData = (program: ts.Program) =>
  memoizeByProgram(program, polysemyCache, collectProgramData);

const computeJaccard = (a: ReadonlyArray<string>, b: ReadonlyArray<string>, unionSize: number) =>
  unionSize === 0
    ? 1
    : pipe(a, RA.filter((x) => new Set(b).has(x))).length / unionSize;

const jaccardSimilarity = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  computeJaccard(a, b, new Set([...a, ...b]).size);

const hasOverlapBelow = (
  indexed: ReadonlyArray<Readonly<Record<"idx", number> & { readonly cluster: ModuleFieldUsage }>>,
  maxOverlap: number,
) =>
  pipe(
    indexed,
    RA.some(({ idx: idx1, cluster: c1 }) =>
      pipe(
        indexed,
        RA.some(({ idx: idx2, cluster: c2 }) => idx2 > idx1 && jaccardSimilarity(c1.fields, c2.fields) <= maxOverlap),
      ),
    ),
  );

const hasDisjointPair = (clusters: ReadonlyArray<ModuleFieldUsage>, maxOverlap: number) =>
  hasOverlapBelow(pipe(clusters, RA.mapWithIndex((idx, cluster) => ({ idx, cluster }))), maxOverlap);

const groupEdgesByModule = (edges: ReadonlyArray<AccessEdge>, model: ModelDef) =>
  pipe(
    edges,
    RA.filter((e) => model.fields.has(e.field)),
    RNEA.groupBy((e) => e.modulePath),
    R.toEntries,
    RA.map(([modulePath, moduleEdges]) => ({
      modulePath,
      fields: pipe(moduleEdges, RA.map((e) => e.field), RA.uniq(S.Eq), RA.sort(S.Ord)),
    })),
  );

type PolysemyThresholds = Readonly<Record<"minFields" | "minClusterFields" | "maxOverlap", number>>;

const toPolysemyFinding = (
  model: ModelDef,
  edges: ReadonlyArray<AccessEdge>,
  { minFields, minClusterFields, maxOverlap }: PolysemyThresholds,
) =>
  model.fields.size < minFields
    ? O.none
    : pipe(
        groupEdgesByModule(edges, model),
        RA.filter((c) => c.fields.length >= minClusterFields),
        (clusters) =>
          clusters.length >= 2 && hasDisjointPair(clusters, maxOverlap)
            ? O.some<PolysemyFinding>({
                modelKey: model.modelKey,
                modelName: model.modelName,
                location: model.location,
                clusters,
              })
            : O.none,
      );

const indexPolysemyFindings = (findings: ReadonlyArray<PolysemyFinding>) => ({
  findings,
  byLocation: pipe(
    findings,
    RA.reduce({}, (acc: Readonly<Record<string, PolysemyFinding>>, f) => ({
      ...acc,
      [makeLocationKey(f.location)]: f,
    })),
  ),
});

type PolysemyIndex = Readonly<{
  readonly findings: ReadonlyArray<PolysemyFinding>;
  readonly byLocation: Readonly<Record<string, PolysemyFinding>>;
}>;

const polysemyIndexCache = new WeakMap<ts.Program, Readonly<Record<string, PolysemyIndex>>>();

const computePolysemyIndex = (
  program: ts.Program,
  thresholds: PolysemyThresholds,
) =>
  pipe(
    getProgramData(program),
    (data) =>
      pipe(
        R.toEntries(data.models),
        RA.filterMap(([, model]) =>
          toPolysemyFinding(model, data.edgesByModel[model.modelKey] ?? [], thresholds),
        ),
      ),
    indexPolysemyFindings,
  );

export const analyzePolysemy = (
  program: ts.Program,
  minFields = 4,
  minClusterFields = 2,
  maxOverlap = 0.2,
) =>
  memoizeByProgramAndKey(
    program,
    `${String(minFields)}:${String(minClusterFields)}:${String(maxOverlap)}`,
    polysemyIndexCache,
    (p) => computePolysemyIndex(p, { minFields, minClusterFields, maxOverlap }),
  );
