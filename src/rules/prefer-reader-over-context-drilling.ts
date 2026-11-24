import {
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESLint,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import {
  analyzeContextDrilling,
  ContextDrillingFinding,
} from "../analyzers/context-drilling-analyzer.js";
import { hasFunctionInit } from "../lib/estree-function-nodes.js";
import { createRule } from "../lib/rule-factory.js";
import { makeLocationKey, resolveTsNodeOwnLocation } from "../lib/ts-node-location.js";

type Options = [Readonly<Record<"minDepth", number>>];
type MessageIds = "contextDrilling";

const resolveTsLocationKey = flow(resolveTsNodeOwnLocation, makeLocationKey);

const resolveNodeLocationKey = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => resolveTsLocationKey(services.esTreeNodeToTSNodeMap.get(node));

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

const reportDrillingFindings =
  (
    services: ParserServicesWithTypeInformation,
    report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
  ) =>
  (
    node: TSESTree.Node,
    locationIndex: Readonly<Record<string, ReadonlyArray<ContextDrillingFinding>>>,
  ) => {
    O.map(
      RA.map((finding: ContextDrillingFinding) => {
        report(toDrillingDescriptor(node, finding));
      }),
    )(O.fromNullable(locationIndex[resolveNodeLocationKey(node, services)]));
  };

const checkNamedFnNode =
  (minDepth: number, services: ParserServicesWithTypeInformation) =>
  (report: (d: TSESLint.ReportDescriptor<MessageIds>) => void) =>
  (node: TSESTree.FunctionDeclaration | TSESTree.VariableDeclarator) => {
    reportDrillingFindings(services, report)(
      node,
      analyzeContextDrilling(services.program, minDepth).locationIndex,
    );
  };

const buildDrillingListeners =
  (minDepth: number, services: ParserServicesWithTypeInformation) =>
  (report: (d: TSESLint.ReportDescriptor<MessageIds>) => void) => {
    const check = checkNamedFnNode(minDepth, services)(report);
    return {
      FunctionDeclaration: check,
      VariableDeclarator: (node: TSESTree.VariableDeclarator) => {
        O.map(check)(O.fromPredicate(hasFunctionInit)(node));
      },
    };
  };

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
    buildDrillingListeners(options.minDepth, ESLintUtils.getParserServices(context))((d) => {
      context.report(d);
    }),
});
