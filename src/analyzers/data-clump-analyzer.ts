import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as R from "fp-ts/lib/Record.js";
import * as S from "fp-ts/lib/string.js";
import { flow, pipe } from "fp-ts/lib/function.js";
import * as ts from "typescript";
import { getProjectSourceFiles, memoizeByProgram, memoizeByProgramAndKey } from "../utils/program-cache.js";
import {
  collectTsNodes,
  getTsNodeLocation,
  getTsParameterNameText,
  getTsTypeMemberName,
  isTsEntityProperty,
  makeLocationKey,
  TsLocation,
} from "../utils/ts-ast-helpers.js";

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

const DEFAULT_IGNORED_NAMES = new Set([
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

const suggestClumpName = (fields: ReadonlyArray<string>) =>
  pipe(
    R.lookup(fields.join(","), KNOWN_CLUMPS),
    O.getOrElse(() => "ValueObject"),
  );

const filterAndSortFields = (names: ReadonlyArray<string>, ignored: ReadonlySet<string>) =>
  pipe(
    names,
    RA.filter((name) => name.length > 1 && !ignored.has(name)),
    RA.uniq(S.Eq),
    RA.sort(S.Ord),
  );

const isNonFunctionParam = (p: ts.ParameterDeclaration) =>
  !(p.type && ts.isFunctionTypeNode(p.type));

const extractFunctionBag = (node: ts.SignatureDeclarationBase, sf: ts.SourceFile) => {
  const fields = filterAndSortFields(
    pipe(node.parameters, RA.filter(isNonFunctionParam), RA.filterMap(getTsParameterNameText)),
    DEFAULT_IGNORED_NAMES,
  );
  return fields.length >= 2
    ? O.some<FieldBag>({ location: getTsNodeLocation(node, sf), fields })
    : O.none;
};

const extractMemberBag = (
  node: ts.Node,
  members: ReadonlyArray<ts.TypeElement | ts.ClassElement>,
  sf: ts.SourceFile,
) => {
  const fields = filterAndSortFields(
    pipe(members, RA.filter(isTsEntityProperty), RA.filterMap(getTsTypeMemberName)),
    DEFAULT_IGNORED_NAMES,
  );
  return fields.length >= 2
    ? O.some<FieldBag>({ location: getTsNodeLocation(node, sf), fields })
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

const extractFileBags = (sf: ts.SourceFile) =>
  pipe(
    collectTsNodes(sf, sf),
    RA.filterMap((node) => extractNodeBag(node, sf)),
  );

const getProgramFieldBags = (program: ts.Program) =>
  memoizeByProgram(program, clumpCache, flow(getProjectSourceFiles, RA.flatMap(extractFileBags)));

const prependHead = (head: string) => (rest: ReadonlyArray<string>) => [head, ...rest];

type CombineInput = Readonly<Record<"items", ReadonlyArray<string>> & Record<"size", number>>;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive combinations
const combineWithHead = ({ items, size }: CombineInput): ReadonlyArray<ReadonlyArray<string>> =>
  pipe(
    O.fromNullable(items[0]),
    O.match(
      () => [] as ReadonlyArray<ReadonlyArray<string>>,
      (head) => [
        ...pipe(combinations({ items: items.slice(1), size: size - 1 }), RA.map(prependHead(head))),
        ...combinations({ items: items.slice(1), size }),
      ],
    ),
  );

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive combinations
const combineOrEmpty = ({ items, size }: CombineInput): ReadonlyArray<ReadonlyArray<string>> =>
  items.length < size ? [] : combineWithHead({ items, size });

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive combinations
const combinations = (input: CombineInput): ReadonlyArray<ReadonlyArray<string>> =>
  input.size === 0 ? [[]] : combineOrEmpty(input);

const combinationsFor = (items: ReadonlyArray<string>) => (size: number) =>
  combinations({ items, size });

type SizeRange = Readonly<Record<"minSize" | "maxSize", number>>;

const makeBagSizeRange = (length: number, { minSize, maxSize }: SizeRange) =>
  RA.makeBy(Math.max(0, Math.min(maxSize, length) - minSize + 1), (i) => i + minSize);

const expandBoundedSubsets = (
  bounded: ReadonlyArray<string>,
  location: TsLocation,
  range: SizeRange,
) =>
  pipe(
    makeBagSizeRange(bounded.length, range),
    RA.flatMap(combinationsFor(bounded)),
    RA.map((fields) => ({ key: fields.join(","), fields, location })),
  );

const getBagSubsets = (bag: FieldBag, minSize: number, maxSize: number) =>
  expandBoundedSubsets(bag.fields.slice(0, 12), bag.location, { minSize, maxSize });

const appendLocationToMap = (
  acc: Readonly<Record<string, ReadonlyArray<TsLocation>>>,
  entry: Readonly<Record<"key", string> & { readonly location: TsLocation }>,
) => ({
  ...acc,
  [entry.key]: [...(acc[entry.key] ?? []), entry.location],
});

const uniqueLocations = (locs: ReadonlyArray<TsLocation>) =>
  pipe(
    locs,
    RA.reduce([] as ReadonlyArray<TsLocation>, (acc, loc) =>
      pipe(acc, RA.some((existing) => makeLocationKey(existing) === makeLocationKey(loc)))
        ? acc
        : [...acc, loc],
    ),
  );

const addFindingToLocationMap = (
  acc: Readonly<Record<string, ReadonlyArray<ClumpFinding>>>,
  finding: ClumpFinding,
) =>
  pipe(
    finding.locations,
    RA.reduce(acc, (innerAcc, loc) => {
      const locKey = makeLocationKey(loc);
      return { ...innerAcc, [locKey]: [...(innerAcc[locKey] ?? []), finding] };
    }),
  );

const isSubsumedByLargerFinding = (
  candidate: ClumpFinding,
  allFindings: ReadonlyArray<ClumpFinding>,
) =>
  pipe(
    allFindings,
    RA.some(
      (other) =>
        other.key !== candidate.key &&
        other.fields.length > candidate.fields.length &&
        other.locations.length >= candidate.locations.length &&
        pipe(candidate.fields, RA.every((f) => other.fields.includes(f))),
    ),
  );

const toClumpFinding = (
  [key, locs]: readonly [string, ReadonlyArray<TsLocation>],
  minOccurrences: number,
) => {
  const deduped = uniqueLocations(locs);
  return deduped.length >= minOccurrences
    ? O.some<ClumpFinding>({
        key,
        fields: key.split(","),
        suggestedName: suggestClumpName(key.split(",")),
        locations: deduped,
      })
    : O.none;
};

const collectRawFindings = (program: ts.Program, minSize: number, minOccurrences: number) =>
  pipe(
    getProgramFieldBags(program),
    RA.flatMap((bag) => getBagSubsets(bag, minSize, 3)),
    RA.reduce({}, appendLocationToMap),
    R.toEntries,
    RA.filterMap((entry) => toClumpFinding(entry, minOccurrences)),
  );

const filterSubsumed = (rawFindings: ReadonlyArray<ClumpFinding>) =>
  pipe(
    rawFindings,
    RA.filter((f) => !isSubsumedByLargerFinding(f, rawFindings)),
  );

const clumpIndexCache = new WeakMap<ts.Program, Readonly<Record<string, ClumpIndex>>>();

export const analyzeDataClumps = (
  program: ts.Program,
  minSize = 2,
  minOccurrences = 3,
) =>
  memoizeByProgramAndKey(
    program,
    `${String(minSize)}:${String(minOccurrences)}`,
    clumpIndexCache,
    (p) =>
      pipe(
        collectRawFindings(p, minSize, minOccurrences),
        filterSubsumed,
        (findings) => ({
          findings,
          byLocation: pipe(findings, RA.reduce({}, addFindingToLocationMap)),
        }),
      ),
  );
