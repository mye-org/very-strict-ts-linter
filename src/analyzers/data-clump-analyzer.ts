import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RNEA from "fp-ts/lib/ReadonlyNonEmptyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { collectProjectSourceFiles } from "../lib/source-paths.js";
import { memoizeByProgram, memoizeByProgramAndKey } from "../lib/program-memo.js";
import { collectTsNodes } from "../lib/ts-node-traversal.js";
import { makeLocationKey, resolveTsNodeLocation, TsLocation } from "../lib/ts-node-location.js";

const resolveTsPropertyNameText = (name: ts.PropertyName) =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? O.some(name.text)
    : O.none;

const resolveTsParameterNameText = (param: ts.ParameterDeclaration) =>
  ts.isIdentifier(param.name) ? O.some(param.name.text) : O.none;

const resolveTsTypeMemberName = (member: ts.TypeElement | ts.ClassElement) =>
  ts.isPropertySignature(member) ||
  ts.isPropertyDeclaration(member) ||
  ts.isMethodSignature(member) ||
  ts.isMethodDeclaration(member)
    ? resolveTsPropertyNameText(member.name)
    : O.none;

const isTsEntityProperty = (member: ts.TypeElement | ts.ClassElement) =>
  ts.isPropertySignature(member) || ts.isPropertyDeclaration(member);

export type ClumpFinding = Readonly<
  Record<"key" | "suggestedName", string> & {
    readonly fields: ReadonlyArray<string>;
    readonly locations: ReadonlyArray<TsLocation>;
  }
>;

export type ClumpIndex = Readonly<{
  readonly findings: ReadonlyArray<ClumpFinding>;
  readonly byLocation: Readonly<Record<string, ReadonlyArray<ClumpFinding>>>;
}>;

type FieldBag = Readonly<{
  readonly location: TsLocation;
  readonly fields: ReadonlyArray<string>;
}>;

const DEFAULT_IGNORED_NAMES: ReadonlySet<string> = new Set([
  "id",
  "value",
  "input",
  "output",
  "options",
  "opts",
  "config",
  "props",
  "state",
  "context",
  "ctx",
  "req",
  "res",
  "kind",
  "type",
  "_tag",
  "tag",
  "URI",
  "_A",
  "node",
  "report",
  "services",
  "checker",
  "program",
  "sf",
  "messageId",
  "data",
  "acc",
  "index",
  "key",
  "file",
  "line",
  "name",
  "pattern",
  "patterns",
  "expr",
  "member",
  "param",
  "prop",
  "call",
  "arg",
  "args",
  "fn",
  "cb",
  "err",
  "error",
]);

const KNOWN_CLUMPS = {
  "amount,currency": "Money",
  "currency,value": "Money",
  "lat,lng": "GeoPoint",
  "latitude,longitude": "GeoPoint",
  "endDate,startDate": "DateRange",
  "endAt,startAt": "DateRange",
  "from,to": "DateRange",
  "city,postalCode,street": "Address",
  "city,street,zip": "Address",
  "city,country,street": "Address",
  "height,width": "Dimensions",
} as const satisfies Readonly<Record<string, string>>;

const clumpCache = new WeakMap<ts.Program, ReadonlyArray<FieldBag>>();

const joinComma = (items: ReadonlyArray<string>) => items.join(",");
const splitComma = (key: string) => key.split(",");

const suggestClumpName = flow(
  joinComma,
  (key) => RR.lookup(key, KNOWN_CLUMPS),
  O.getOrElse(() => "ValueObject"),
);

const filterAndSortFields = (ignored: ReadonlySet<string>) =>
  flow(
    RA.filter((name: string) => name.length > 1 && !ignored.has(name)),
    RA.uniq(S.Eq),
    RA.sort(S.Ord),
  );

const filterAndSortDefaultFields = filterAndSortFields(DEFAULT_IGNORED_NAMES);

const isNonFunctionParam = (p: ts.ParameterDeclaration) =>
  !(p.type && ts.isFunctionTypeNode(p.type));

const extractParamFields = flow(
  RA.filter(isNonFunctionParam),
  RA.filterMap(resolveTsParameterNameText),
  filterAndSortDefaultFields,
);

const extractMemberFields = flow(
  RA.filter(isTsEntityProperty),
  RA.filterMap(resolveTsTypeMemberName),
  filterAndSortDefaultFields,
);

const extractFunctionBag = (sf: ts.SourceFile) => (node: ts.SignatureDeclarationBase) => {
  const fields = extractParamFields(node.parameters);
  return fields.length >= 2
    ? O.some<FieldBag>({ location: resolveTsNodeLocation(sf)(node), fields })
    : O.none;
};

const extractMemberBag =
  (sf: ts.SourceFile) =>
  (node: ts.TypeLiteralNode | ts.InterfaceDeclaration | ts.ClassDeclaration) => {
    const fields = extractMemberFields(node.members);
    return fields.length >= 2
      ? O.some<FieldBag>({ location: resolveTsNodeLocation(sf)(node), fields })
      : O.none;
  };

const isFunctionLikeTs = (node: ts.Node): node is ts.SignatureDeclarationBase =>
  ts.isFunctionDeclaration(node) ||
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node);

const isMemberContainerTs = (
  node: ts.Node,
): node is ts.TypeLiteralNode | ts.InterfaceDeclaration | ts.ClassDeclaration =>
  ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node);

const extractMemberBagNode = (sf: ts.SourceFile) => (node: ts.Node) =>
  isMemberContainerTs(node) ? extractMemberBag(sf)(node) : O.none;

const extractNodeBag = (sf: ts.SourceFile) => (node: ts.Node) =>
  isFunctionLikeTs(node) ? extractFunctionBag(sf)(node) : extractMemberBagNode(sf)(node);

const collectFileNodes = (sf: ts.SourceFile) => collectTsNodes(sf)(sf);

const extractFileBags = (sf: ts.SourceFile) =>
  RA.filterMap(extractNodeBag(sf))(collectFileNodes(sf));

const collectAllProgramBags = flow(collectProjectSourceFiles, RA.flatMap(extractFileBags));

const collectProgramFieldBags = memoizeByProgram(clumpCache)(collectAllProgramBags);

const prependHead = (head: string) => (rest: ReadonlyArray<string>) => [head, ...rest];
const tailItems = (items: ReadonlyArray<string>) => items.slice(1);

type CombineInput = Readonly<Record<"items", ReadonlyArray<string>> & Record<"size", number>>;

const combinePrefixed =
  (head: string) =>
  ({ items, size }: CombineInput) =>
    RA.map(prependHead(head))(combinations({ items: tailItems(items), size: size - 1 }));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive combinations
const combineWithHead = ({ items, size }: CombineInput): ReadonlyArray<ReadonlyArray<string>> =>
  O.match(
    () => [] satisfies ReadonlyArray<ReadonlyArray<string>>,
    (head: string) => [
      ...combinePrefixed(head)({ items, size }),
      ...combinations({ items: tailItems(items), size }),
    ],
  )(O.fromNullable(items[0]));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive combinations
const combineOrEmpty = ({ items, size }: CombineInput): ReadonlyArray<ReadonlyArray<string>> =>
  items.length < size ? [] : combineWithHead({ items, size });

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive combinations
const combinations = (input: CombineInput): ReadonlyArray<ReadonlyArray<string>> =>
  input.size === 0 ? [[]] : combineOrEmpty(input);

const combinationsFor = (items: ReadonlyArray<string>) => (size: number) =>
  combinations({ items, size });

type SizeRange = Readonly<Record<"minSize" | "maxSize", number>>;

const countRangeSteps =
  (length: number) =>
  ({ minSize, maxSize }: SizeRange) =>
    Math.max(0, Math.min(maxSize, length) - minSize + 1);

const makeBagSizeRange = (length: number) => (range: SizeRange) =>
  RA.makeBy(countRangeSteps(length)(range), (i) => i + range.minSize);

const expandSubsetsForLocation = (location: TsLocation) => (bounded: ReadonlyArray<string>) =>
  flow(
    RA.flatMap(combinationsFor(bounded)),
    RA.map((fields: ReadonlyArray<string>) => ({ key: joinComma(fields), fields, location })),
  );

const expandBoundedSubsets = (range: SizeRange) => (boundedBag: FieldBag) =>
  expandSubsetsForLocation(boundedBag.location)(boundedBag.fields)(
    makeBagSizeRange(boundedBag.fields.length)(range),
  );

const capFieldList = (fields: ReadonlyArray<string>) => fields.slice(0, 12);

const collectBagSubsets = (range: SizeRange) => (bag: FieldBag) =>
  expandBoundedSubsets(range)({ fields: capFieldList(bag.fields), location: bag.location });

type KeyedSubsetLocation = Readonly<Record<"key", string> & { readonly location: TsLocation }>;

const extractEntryLocations = RA.map((entry: KeyedSubsetLocation) => entry.location);

const groupSubsetsByKey = flow(
  RNEA.groupBy((entry: KeyedSubsetLocation) => entry.key),
  RR.map(extractEntryLocations),
);

const uniqueLocations = flow(
  RNEA.groupBy(makeLocationKey),
  RR.toEntries,
  RA.map(([, group]) => RNEA.head(group)),
);

const hasAllFields =
  (otherFields: ReadonlyArray<string>) => (candidateFields: ReadonlyArray<string>) =>
    RA.every((f: string) => otherFields.includes(f))(candidateFields);

const isSubsumedByLargerFinding =
  (allFindings: ReadonlyArray<ClumpFinding>) => (candidate: ClumpFinding) =>
    RA.some(
      (other: ClumpFinding) =>
        other.key !== candidate.key &&
        other.fields.length > candidate.fields.length &&
        other.locations.length >= candidate.locations.length &&
        hasAllFields(other.fields)(candidate.fields),
    )(allFindings);

const buildClumpFinding = (locations: ReadonlyArray<TsLocation>) => (key: string) => {
  const fields = splitComma(key);
  return {
    key,
    fields,
    suggestedName: suggestClumpName(fields),
    locations,
  };
};

const toClumpFinding =
  (minOccurrences: number) =>
  ([key, locs]: readonly [string, ReadonlyArray<TsLocation>]) => {
    const deduped = uniqueLocations(locs);
    return deduped.length >= minOccurrences
      ? O.some<ClumpFinding>(buildClumpFinding(deduped)(key))
      : O.none;
  };

export type ClumpThresholds = Readonly<Record<"minSize" | "minOccurrences", number>>;

const DEFAULT_CLUMP_THRESHOLDS: ClumpThresholds = {
  minSize: 2,
  minOccurrences: 3,
};

const resolveMaxClumpSize = (minSize: number) => Math.max(3, minSize);

const collectBagSubsetsForMinSize = (minSize: number) => (bag: FieldBag) =>
  collectBagSubsets({ minSize, maxSize: resolveMaxClumpSize(minSize) })(bag);

const collectRawFindingsForThresholds = (thresholds: ClumpThresholds) =>
  flow(
    collectProgramFieldBags,
    RA.flatMap(collectBagSubsetsForMinSize(thresholds.minSize)),
    groupSubsetsByKey,
    RR.toEntries,
    RA.filterMap(toClumpFinding(thresholds.minOccurrences)),
  );

const filterSubsumed = (rawFindings: ReadonlyArray<ClumpFinding>) =>
  RA.filter((f: ClumpFinding) => !isSubsumedByLargerFinding(rawFindings)(f))(rawFindings);

const clumpIndexCache = new WeakMap<ts.Program, Readonly<Record<string, ClumpIndex>>>();

const expandFindingLocations = (finding: ClumpFinding) =>
  RA.map((loc: TsLocation) => [makeLocationKey(loc), finding] as const)(finding.locations);

const extractFindingFromPair = ([, finding]: readonly [string, ClumpFinding]) => finding;

const indexFindingsByLocation = flow(
  RA.flatMap(expandFindingLocations),
  RNEA.groupBy(([locKey]) => locKey),
  RR.map(RA.map(extractFindingFromPair)),
);

const buildClumpIndex = (findings: ReadonlyArray<ClumpFinding>) => ({
  findings,
  byLocation: indexFindingsByLocation(findings),
});

const computeClumpIndexForThresholds = (thresholds: ClumpThresholds) =>
  flow(collectRawFindingsForThresholds(thresholds), filterSubsumed, buildClumpIndex);

const makeClumpCacheKey = (thresholds: ClumpThresholds) =>
  `${String(thresholds.minSize)}:${String(thresholds.minOccurrences)}`;

export const analyzeDataClumps = ((program: ts.Program) =>
  (thresholds: Partial<ClumpThresholds> = {}) => {
    const resolved: ClumpThresholds = { ...DEFAULT_CLUMP_THRESHOLDS, ...thresholds };
    return memoizeByProgramAndKey(clumpIndexCache)(
      computeClumpIndexForThresholds(resolved),
    )(program)(makeClumpCacheKey(resolved));
  }) satisfies (
  program: ts.Program,
) => (thresholds?: Partial<ClumpThresholds>) => ClumpIndex;
