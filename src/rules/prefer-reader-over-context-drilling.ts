import {
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import {
  analyzeContextDrilling,
  ContextDrillingFinding,
} from "../analyzers/context-drilling-analyzer.js";
import { createRule } from "../utils/create-rule.js";
import { getTsNodeOwnLocation, makeLocationKey } from "../utils/ts-ast-helpers.js";
import { hasFunctionInit } from "../utils/type-helpers.js";

type Options = [Readonly<Record<"minDepth", number>>];
type MessageIds = "contextDrilling";

const getNodeLocationKey = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => pipe(services.esTreeNodeToTSNodeMap.get(node), getTsNodeOwnLocation, makeLocationKey);

const toDrillingDescriptor = (node: TSESTree.Node, finding: ContextDrillingFinding) => ({
  node,
  messageId: "contextDrilling" as const,
  data: {
    param: finding.paramName,
    type: finding.typeName,
    depth: String(finding.depth),
    chain: finding.chain.join(" -> "),
  },
});

const reportDrillingFindings = (
  node: TSESTree.Node,
  locationIndex: Readonly<Record<string, ReadonlyArray<ContextDrillingFinding>>>,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    O.fromNullable(locationIndex[getNodeLocationKey(node, services)]),
    O.map(RA.map((finding) => { report(toDrillingDescriptor(node, finding)); })),
  );
};

const checkNamedFnNode = (
  node: TSESTree.FunctionDeclaration | TSESTree.VariableDeclarator,
  minDepth: number,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  reportDrillingFindings(
    node,
    analyzeContextDrilling(services.program, minDepth).locationIndex,
    services,
    report,
  );
};

const createDrillingListeners = (
  minDepth: number,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => ({
  FunctionDeclaration: (node: TSESTree.FunctionDeclaration) => {
    checkNamedFnNode(node, minDepth, services, report);
  },
  VariableDeclarator: (node: TSESTree.VariableDeclarator) => {
    pipe(
      O.fromPredicate(hasFunctionInit)(node),
      O.map((n) => { checkNamedFnNode(n, minDepth, services, report); }),
    );
  },
});

export const preferReaderOverContextDrilling = createRule<Options, MessageIds>({
  name: "prefer-reader-over-context-drilling",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Detect environment/dependency parameters forwarded untouched across deep call chains; prefer `Reader` or `ReaderTaskEither` dependency injection.",
    },
    messages: {
      contextDrilling:
        "Context parameter `{{param}}: {{type}}` is drilled untouched across {{depth}} hops ({{chain}}). Model the shared environment with `Reader` / `ReaderTaskEither` instead of prop-drilling.",
    },
    schema: [
      {
        type: "object",
        properties: {
          minDepth: { type: "number", minimum: 2 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ minDepth: 3 }],
  },
  create: (context, [options]) =>
    createDrillingListeners(options.minDepth, ESLintUtils.getParserServices(context), (d) => {
      context.report(d);
    }),
});
