import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";

type Options = [Readonly<{ bannedSources: ReadonlyArray<string> }>];
type MessageIds = "forbiddenReactInTs";

const DEFAULT_BANNED_SOURCES = [
  "react",
  "react-dom",
  "react-native",
  "react/",
  "react-dom/",
  "react-native/",
] as const;

const isBannedSource = (source: string, bannedSources: ReadonlyArray<string>) =>
  pipe(
    bannedSources,
    RA.some((pattern) =>
      pattern.endsWith("/")
        ? source.startsWith(pattern)
        : source === pattern || source.startsWith(`${pattern}/`),
    ),
  );

const reportIfBanned = (
  sourceNode: TSESTree.Node,
  source: string,
  bannedSources: ReadonlyArray<string>,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(isBannedSource(source, bannedSources))
    .with(true, () => {
      report({
        node: sourceNode,
        messageId: "forbiddenReactInTs",
        data: { source },
      });
    })
    .with(false, () => {})
    .exhaustive();
};

const checkDynamicImport = (
  node: TSESTree.ImportExpression,
  bannedSources: ReadonlyArray<string>,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    O.some(node.source),
    O.filter(
      (s): s is TSESTree.StringLiteral =>
        s.type === AST_NODE_TYPES.Literal && typeof s.value === "string",
    ),
    O.map((s) => {
      reportIfBanned(s, s.value, bannedSources, report);
    }),
  );
};

const checkExportNamed = (
  node: TSESTree.ExportNamedDeclaration,
  bannedSources: ReadonlyArray<string>,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  pipe(
    O.fromNullable(node.source),
    O.map((src) => {
      reportIfBanned(src, src.value, bannedSources, report);
    }),
  );
};

const buildListeners = (
  bannedSources: ReadonlyArray<string>,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => ({
  ImportDeclaration: (node: TSESTree.ImportDeclaration) => {
    reportIfBanned(node.source, node.source.value, bannedSources, report);
  },
  ExportNamedDeclaration: (node: TSESTree.ExportNamedDeclaration) => {
    checkExportNamed(node, bannedSources, report);
  },
  ExportAllDeclaration: (node: TSESTree.ExportAllDeclaration) => {
    reportIfBanned(node.source, node.source.value, bannedSources, report);
  },
  ImportExpression: (node: TSESTree.ImportExpression) => {
    checkDynamicImport(node, bannedSources, report);
  },
});

export const noReactInTs = createRule<Options, MessageIds>({
  name: "no-react-in-ts",
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid React and React Native imports in .ts files so pure TypeScript modules remain framework-free.",
    },
    messages: {
      forbiddenReactInTs:
        "React/React Native import `{{source}}` is forbidden in .ts files. Keep .ts files framework-free and move UI/hook wiring to .tsx.",
    },
    schema: [
      {
        type: "object",
        properties: {
          bannedSources: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ bannedSources: DEFAULT_BANNED_SOURCES }],
  },
  create: (context, [options]) =>
    context.filename.endsWith(".tsx")
      ? {}
      : buildListeners(options.bannedSources, (d) => {
          context.report(d);
        }),
});
