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

const extractFunctionBag = (node: ts.SignatureDeclarationBase, sf: ts.SourceFile) => {
  const fields = extractParamFields(node.parameters);
  return fields.length >= 2
    ? O.some<FieldBag>({ location: resolveTsNodeLocation(node, sf), fields })
    : O.none;
};

const extractMemberBag = (
  node: ts.Node,
  members: ReadonlyArray<ts.TypeElement | ts.ClassElement>,
  sf: ts.SourceFile,
) => {
  const fields = extractMemberFields(members);
  return fields.length >= 2
    ? O.some<FieldBag>({ location: resolveTsNodeLocation(node, sf), fields })
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

const extractMemberBagNode = (node: ts.Node, sf: ts.SourceFile) =>
  isMemberContainerTs(node) ? extractMemberBag(node, node.members, sf) : O.none;

const extractNodeBag = (node: ts.Node, sf: ts.SourceFile) =>
  isFunctionLikeTs(node) ? extractFunctionBag(node, sf) : extractMemberBagNode(node, sf);

const collectFileNodes = (sf: ts.SourceFile) => collectTsNodes(sf, sf);

const extractFileBags = flow(
  (sf: ts.SourceFile) => ({ sf, nodes: collectFileNodes(sf) }),
  ({ sf, nodes }) => RA.filterMap((node: ts.Node) => extractNodeBag(node, sf))(nodes),
);

const collectAllProgramBags = flow(collectProjectSourceFiles, RA.flatMap(extractFileBags));

const collectProgramFieldBags = (program: ts.Program) =>
  memoizeByProgram(program, clumpCache, collectAllProgramBags);

const prependHead = (head: string) => (rest: ReadonlyArray<string>) => [head, ...rest];
const tailItems = (items: ReadonlyArray<string>) => items.slice(1);

type CombineInput = Readonly<Record<"items", ReadonlyArray<string>> & Record<"size", number>>;

const combinePrefixed = (head: string, items: ReadonlyArray<string>, size: number) =>
  RA.map(prependHead(head))(combinations({ items: tailItems(items), size: size - 1 }));

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive combinations
const combineWithHead = ({ items, size }: CombineInput): ReadonlyArray<ReadonlyArray<string>> =>
  O.match(
    () => [] satisfies ReadonlyArray<ReadonlyArray<string>>,
    (head: string) => [
      ...combinePrefixed(head, items, size),
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

const countRangeSteps = (length: number, { minSize, maxSize }: SizeRange) =>
  Math.max(0, Math.min(maxSize, length) - minSize + 1);

const makeBagSizeRange = (length: number, range: SizeRange) =>
  RA.makeBy(countRangeSteps(length, range), (i) => i + range.minSize);

const expandSubsetsForLocation = (bounded: ReadonlyArray<string>, location: TsLocation) =>
  flow(
    RA.flatMap(combinationsFor(bounded)),
    RA.map((fields: ReadonlyArray<string>) => ({ key: joinComma(fields), fields, location })),
  );

const expandBoundedSubsets = (
  bounded: ReadonlyArray<string>,
  location: TsLocation,
  range: SizeRange,
) => expandSubsetsForLocation(bounded, location)(makeBagSizeRange(bounded.length, range));

const capFieldList = (fields: ReadonlyArray<string>) => fields.slice(0, 12);

const collectBagSubsets = (bag: FieldBag, minSize: number, maxSize: number) =>
  expandBoundedSubsets(capFieldList(bag.fields), bag.location, { minSize, maxSize });

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

const hasAllFields = (candidateFields: ReadonlyArray<string>, otherFields: ReadonlyArray<string>) =>
  RA.every((f: string) => otherFields.includes(f))(candidateFields);

const isSubsumedByLargerFinding = (
  candidate: ClumpFinding,
  allFindings: ReadonlyArray<ClumpFinding>,
) =>
  RA.some(
    (other: ClumpFinding) =>
      other.key !== candidate.key &&
      other.fields.length > candidate.fields.length &&
      other.locations.length >= candidate.locations.length &&
      hasAllFields(candidate.fields, other.fields),
  )(allFindings);

const buildClumpFinding = (key: string, locations: ReadonlyArray<TsLocation>) => {
  const fields = splitComma(key);
  return {
    key,
    fields,
    suggestedName: suggestClumpName(fields),
    locations,
  };
};

const toClumpFinding = (
  [key, locs]: readonly [string, ReadonlyArray<TsLocation>],
  minOccurrences: number,
) => {
  const deduped = uniqueLocations(locs);
  return deduped.length >= minOccurrences
    ? O.some<ClumpFinding>(buildClumpFinding(key, deduped))
    : O.none;
};

type ClumpThresholds = Readonly<Record<"minSize" | "minOccurrences", number>>;

const resolveMaxClumpSize = (minSize: number) => Math.max(3, minSize);

const collectBagSubsetsForMinSize = (bag: FieldBag, minSize: number) =>
  collectBagSubsets(bag, minSize, resolveMaxClumpSize(minSize));

const collectRawFindingsForThresholds = (thresholds: ClumpThresholds) =>
  flow(
    collectProgramFieldBags,
    RA.flatMap((bag: FieldBag) => collectBagSubsetsForMinSize(bag, thresholds.minSize)),
    groupSubsetsByKey,
    RR.toEntries,
    RA.filterMap((entry) => toClumpFinding(entry, thresholds.minOccurrences)),
  );

const filterSubsumed = (rawFindings: ReadonlyArray<ClumpFinding>) =>
  RA.filter((f: ClumpFinding) => !isSubsumedByLargerFinding(f, rawFindings))(rawFindings);

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

export const analyzeDataClumps = (
  program: ts.Program,
  minSize = 2,
  minOccurrences = 3,
): ClumpIndex => {
  const thresholds = { minSize, minOccurrences };
  return memoizeByProgramAndKey(
    program,
    makeClumpCacheKey(thresholds),
    clumpIndexCache,
    computeClumpIndexForThresholds(thresholds),
  );
};
