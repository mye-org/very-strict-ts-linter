import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { match } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";
import { shouldLintDomainFile } from "../lib/source-paths.js";

// eslint-disable-next-line strict-fp/prefer-union-over-boolean -- ESLint rule JSON schema boolean option
type ScopeFlag = boolean;

type Options = [
  Readonly<
    Record<"enforceEverywhere", ScopeFlag> & {
      readonly domainPatterns: ReadonlyArray<string>;
      readonly forbiddenImports: ReadonlyArray<string>;
    }
  >,
];
type MessageIds = "forbiddenDomainImport" | "impureDomainRuntime";

const DEFAULT_DOMAIN_PATTERNS = ["**/domain/**", "**/domains/**"];
const DEFAULT_FORBIDDEN_IMPORTS = [
  "prisma",
  "@prisma/",
  "typeorm",
  "drizzle-orm",
  "mongoose",
  "sequelize",
  "knex",
  "kysely",
  "express",
  "fastify",
  "koa",
  "hono",
  "@nestjs/",
  "next/",
  "react",
  "vue",
  "svelte",
  "solid-js",
  "axios",
  "node-fetch",
  "got",
  "undici",
  "fs",
  "node:fs",
  "http",
  "node:http",
  "https",
  "node:https",
  "net",
  "node:net",
  "child_process",
  "node:child_process",
];

const IMPURE_MEMBER_METHODS = {
  Date: new Set(["now"]),
  Math: new Set(["random"]),
  crypto: new Set(["randomUUID"]),
} as const satisfies Readonly<Record<string, ReadonlySet<string>>>;

const IMPURE_DIRECT_CALLS: ReadonlySet<string> = new Set(["fetch"]);
const PROCESS_GLOBAL_NAMES: ReadonlySet<string> = new Set(["process"]);
const ENV_PROPERTY_NAMES: ReadonlySet<string> = new Set(["env"]);
const DATE_CONSTRUCTOR_NAMES: ReadonlySet<string> = new Set(["Date"]);

const isForbiddenImportSource = (
  source: string,
  forbiddenImports: ReadonlyArray<string>,
) =>
  RA.some((pattern: string) =>
    pattern.endsWith("/")
      ? source.startsWith(pattern)
      : source === pattern || source.startsWith(`${pattern}/`),
  )(forbiddenImports);

const isImpureConsoleCall = (objName: string) => objName === "console";

const hasImpureMemberMethod = (objName: string, propName: string) =>
  O.exists((methods: ReadonlySet<string>) => methods.has(propName))(
    RR.lookup(objName, IMPURE_MEMBER_METHODS),
  );

const isImpureMemberCall = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.MemberExpression &&
  callee.object.type === AST_NODE_TYPES.Identifier &&
  callee.property.type === AST_NODE_TYPES.Identifier &&
  (isImpureConsoleCall(callee.object.name) ||
    hasImpureMemberMethod(callee.object.name, callee.property.name));

const isImpureDirectCall = (callee: TSESTree.Expression) =>
  callee.type === AST_NODE_TYPES.Identifier && IMPURE_DIRECT_CALLS.has(callee.name);

const isProcessEnvAccess = (node: TSESTree.MemberExpression) =>
  node.object.type === AST_NODE_TYPES.Identifier &&
  PROCESS_GLOBAL_NAMES.has(node.object.name) &&
  node.property.type === AST_NODE_TYPES.Identifier &&
  ENV_PROPERTY_NAMES.has(node.property.name);

const isZeroArgNewDate = (node: TSESTree.NewExpression) =>
  node.callee.type === AST_NODE_TYPES.Identifier &&
  DATE_CONSTRUCTOR_NAMES.has(node.callee.name) &&
  node.arguments.length === 0;

const checkImportNode = (
  forbiddenImports: ReadonlyArray<string>,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => (node: TSESTree.ImportDeclaration) => {
  match(isForbiddenImportSource(node.source.value, forbiddenImports))
    .with(true, () => {
      report({ node: node.source, messageId: "forbiddenDomainImport", data: { source: node.source.value } });
    })
    .with(false, () => {})
    .exhaustive();
};

const checkWhenImpure = (
  expr: string,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => (target: TSESTree.Node, predicate: () => boolean) => {
  match(predicate())
    .with(true, () => {
      report({ node: target, messageId: "impureDomainRuntime", data: { expr } });
    })
    .with(false, () => {})
    .exhaustive();
};

const buildPurityListeners = (
  forbiddenImports: ReadonlyArray<string>,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => ({
  ImportDeclaration: checkImportNode(forbiddenImports, report),
  CallExpression: (node: TSESTree.CallExpression) => {
    checkWhenImpure("impure runtime call", report)(node, () => isImpureMemberCall(node.callee) || isImpureDirectCall(node.callee));
  },
  NewExpression: (node: TSESTree.NewExpression) => {
    checkWhenImpure("new Date()", report)(node, () => isZeroArgNewDate(node));
  },
  MemberExpression: (node: TSESTree.MemberExpression) => {
    checkWhenImpure("process.env", report)(node, () => isProcessEnvAccess(node));
  },
});

export const domainLayerPurity = createRule<Options, MessageIds>({
  name: "domain-layer-purity",
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce purity in domain layer files by disallowing infrastructure imports (ORMs, HTTP, UI, fs) and impure runtime globals (`Date.now()`, `Math.random()`, `process.env`).",
    },
    messages: {
      forbiddenDomainImport:
        "Forbidden infrastructure import `{{source}}` in domain layer. Depend on domain ports/interfaces instead.",
      impureDomainRuntime:
        "Impure runtime dependency ({{expr}}) inside domain layer. Inject a `Clock`, `IdGenerator`, or config port instead.",
    },
    schema: [
      {
        type: "object",
        properties: {
          enforceEverywhere: { type: "boolean" },
          domainPatterns: { type: "array", items: { type: "string" } },
          forbiddenImports: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        enforceEverywhere: false,
        domainPatterns: DEFAULT_DOMAIN_PATTERNS,
        forbiddenImports: DEFAULT_FORBIDDEN_IMPORTS,
      },
    ],
  },
  create: (context, [options]) =>
    shouldLintDomainFile(
      options.enforceEverywhere ? "everywhere" : "domain-only",
      options.domainPatterns,
    )(context.filename)
      ? buildPurityListeners(options.forbiddenImports, (d) => { context.report(d); })
      : {},
});
