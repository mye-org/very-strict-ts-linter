import {
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { flow } from "fp-ts/lib/function.js";
import { DEFAULT_TEST_PATTERNS } from "../analyzers/module-symbol-graph.js";
import {
  analyzeTestScope,
  DEFAULT_TEST_SCOPE_OPTIONS,
  LowestLevelFinding,
} from "../analyzers/test-scope-analyzer.js";
import { createRule } from "../lib/rule-factory.js";
import { isMatchingAnyPattern, normalizeFilePath } from "../lib/source-paths.js";

type Options = [
  Partial<
    Readonly<{ readonly testPatterns: ReadonlyArray<string> }> &
      Readonly<Record<"minDelegatedCases", number>>
  >,
];

type MessageIds = "preferLowestTestLevel";

const toLineLoc = (line: number) => ({
  start: { line, column: 0 },
  end: { line, column: 1 },
});

const formatCaseCount = (caseCount: number) => String(caseCount);

const toFindingDescriptor = (finding: LowestLevelFinding) => ({
  loc: toLineLoc(finding.line),
  messageId: "preferLowestTestLevel" as const,
  data: {
    testName: finding.testName,
    property: finding.property,
    lowerComponent: finding.lowerComponent,
    higherComponent: finding.higherComponent,
    caseCount: formatCaseCount(finding.caseCount),
  },
});

const EMPTY_FINDINGS: ReadonlyArray<LowestLevelFinding> = [];

const resolveTestPatterns = flow(
  (options: Options[0]) => options.testPatterns,
  O.fromNullable,
  O.getOrElseW(() => DEFAULT_TEST_PATTERNS),
);

const resolveScopeOptions = (options: Options[0]) => ({
  ...DEFAULT_TEST_SCOPE_OPTIONS,
  testPatterns: resolveTestPatterns(options),
  minDelegatedCases: O.getOrElse(() => DEFAULT_TEST_SCOPE_OPTIONS.minDelegatedCases)(
    O.fromNullable(options.minDelegatedCases),
  ),
});

const reportLowestLevelFindings =
  (
    services: ParserServicesWithTypeInformation,
    report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
  ) =>
  (fileName: string, scopeOptions: ReturnType<typeof resolveScopeOptions>) => {
    const run = flow(
      (f: string) => RR.lookup(f, analyzeTestScope(services.program, scopeOptions).lowestLevelByFile),
      O.getOrElse(() => EMPTY_FINDINGS),
      RA.map((finding: LowestLevelFinding) => {
        report(toFindingDescriptor(finding));
      }),
    );
    run(fileName);
  };

const resolveProgramFileName = (
  programNode: TSESTree.Program,
  services: ParserServicesWithTypeInformation,
) => normalizeFilePath(services.esTreeNodeToTSNodeMap.get(programNode).fileName);

const checkProgram =
  (
    services: ParserServicesWithTypeInformation,
    report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
  ) =>
  (
    programNode: TSESTree.Program,
    scopeOptions: ReturnType<typeof resolveScopeOptions>,
  ) => {
    const check = flow(
      O.fromPredicate(isMatchingAnyPattern(scopeOptions.testPatterns)),
      O.map((fileName) => {
        reportLowestLevelFindings(services, report)(fileName, scopeOptions);
      }),
    );
    check(resolveProgramFileName(programNode, services));
  };

const buildLowestLevelListeners =
  (options: Options[0], services: ParserServicesWithTypeInformation) =>
  (report: (d: TSESLint.ReportDescriptor<MessageIds>) => void) => ({
    Program: (programNode: TSESTree.Program) => {
      checkProgram(services, report)(programNode, resolveScopeOptions(options));
    },
  });

export const preferLowestTestLevel = createRule<Options, MessageIds>({
  name: "prefer-lowest-test-level",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce testing correctness properties at the lowest sufficient architectural boundary by flagging repeated verification of an untested exported lower-level component exclusively through a higher-level orchestrator.",
    },
    messages: {
      preferLowestTestLevel:
        "[TESTSCOPE-002] Test '{{testName}}' verifies '{{property}}' owned by lower-level exported component '{{lowerComponent}}' indirectly through '{{higherComponent}}' ({{caseCount}} delegated cases, 0 direct unit tests on '{{lowerComponent}}'). Move behavioral cases to direct unit tests on '{{lowerComponent}}' and keep a minimal composition test on '{{higherComponent}}'.",
    },
    schema: [
      {
        type: "object",
        properties: {
          testPatterns: { type: "array", items: { type: "string" } },
          minDelegatedCases: { type: "number", minimum: 1 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        testPatterns: [...DEFAULT_TEST_PATTERNS],
        minDelegatedCases: DEFAULT_TEST_SCOPE_OPTIONS.minDelegatedCases,
      },
    ],
  },
  create: (context, [options]) =>
    buildLowestLevelListeners(options, ESLintUtils.getParserServices(context))((d) => {
      context.report(d);
    }),
});
