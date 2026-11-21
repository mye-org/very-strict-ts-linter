import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as S from "fp-ts/lib/string.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../utils/create-rule.js";
import { getProjectSourceFiles, isMatchingAnyPattern, memoizeByProgram } from "../utils/program-cache.js";
import { collectTsNodes } from "../utils/ts-ast-helpers.js";
import { getBarePrimitiveOrLiteralKind, isBrandedOrNewtypeTsType } from "../utils/type-helpers.js";

type Options = [Readonly<{ readonly valueObjectPathPatterns: ReadonlyArray<string> }>];
type MessageIds = "scatteredRegex" | "scatteredNormalization" | "scatteredValidationCall";

const DEFAULT_VO_PATHS = ["**/value-objects/**", "**/valueObjects/**", "**/vo/**"];
const VALIDATION_FN_RE = /^(isValid|validate|assertValid)[A-Z]/;

const regexCountCache = new WeakMap<ts.Program, ReadonlyArray<Readonly<Record<"text" | "file", string>>>>();

const collectFileRegexes = (sf: ts.SourceFile) =>
  pipe(
    collectTsNodes(sf, sf),
    RA.filter(ts.isRegularExpressionLiteral),
    RA.map((lit) => ({ text: lit.text, file: sf.fileName })),
  );

const getProgramRegexes = (program: ts.Program) =>
  memoizeByProgram(program, regexCountCache, (p) =>
    pipe(getProjectSourceFiles(p), RA.flatMap(collectFileRegexes)),
  );

const isDuplicatedNonVoRegex = (
  pattern: string,
  program: ts.Program,
  voPatterns: ReadonlyArray<string>,
) =>
  pipe(
    getProgramRegexes(program),
    RA.filter((entry) => entry.text === pattern && !isMatchingAnyPattern(entry.file, voPatterns)),
    RA.map((entry) => entry.file),
    RA.uniq(S.Eq),
  ).length >= 2;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const isInsideFunctionLike = (node: TSESTree.Node): boolean =>
  pipe(
    O.fromNullable(node.parent),
    O.exists(
      (p) =>
        p.type === AST_NODE_TYPES.FunctionDeclaration ||
        p.type === AST_NODE_TYPES.FunctionExpression ||
        p.type === AST_NODE_TYPES.ArrowFunctionExpression ||
        p.type === AST_NODE_TYPES.MethodDefinition ||
        isInsideFunctionLike(p),
    ),
  );

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const getEnclosingFunction = (node: TSESTree.Node): O.Option<TSESTree.Node> =>
  pipe(
    O.fromNullable(node.parent),
    O.flatMap((p) =>
      p.type === AST_NODE_TYPES.FunctionDeclaration ||
      p.type === AST_NODE_TYPES.FunctionExpression ||
      p.type === AST_NODE_TYPES.ArrowFunctionExpression ||
      p.type === AST_NODE_TYPES.MethodDefinition
        ? O.some(p)
        : getEnclosingFunction(p),
    ),
  );

const isConstructorMethod = (fn: TSESTree.Node) =>
  (fn.type === AST_NODE_TYPES.MethodDefinition && fn.kind === "constructor") ||
  (fn.parent?.type === AST_NODE_TYPES.MethodDefinition && fn.parent.kind === "constructor");

const hasBrandedReturnType = (
  fn: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  return pipe(
    O.fromNullable(
      checker.getSignatureFromDeclaration(
        services.esTreeNodeToTSNodeMap.get(fn) as ts.SignatureDeclaration,
      ),
    ),
    O.map((sig) => checker.getReturnTypeOfSignature(sig)),
    O.exists(isBrandedOrNewtypeTsType),
  );
};

const isInsideVoFactory = (
  node: TSESTree.Node,
  fileName: string,
  voPatterns: ReadonlyArray<string>,
  services: ParserServicesWithTypeInformation,
) =>
  isMatchingAnyPattern(fileName, voPatterns) ||
  pipe(
    getEnclosingFunction(node),
    O.exists((fn) => isConstructorMethod(fn) || hasBrandedReturnType(fn, services)),
  );

const VALIDATION_REGEX_METHODS = new Set(["test", "match", "exec"]);

const isRegexValidationCall = (node: TSESTree.Literal) =>
  node.parent.type === AST_NODE_TYPES.MemberExpression &&
  node.parent.object === node &&
  node.parent.property.type === AST_NODE_TYPES.Identifier &&
  VALIDATION_REGEX_METHODS.has(node.parent.property.name);

const isTrimMember = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.CallExpression &&
  expr.callee.type === AST_NODE_TYPES.MemberExpression &&
  expr.callee.property.type === AST_NODE_TYPES.Identifier &&
  expr.callee.property.name === "trim";

const isTrimCaseChain = (node: TSESTree.CallExpression) =>
  node.callee.type === AST_NODE_TYPES.MemberExpression &&
  node.callee.property.type === AST_NODE_TYPES.Identifier &&
  (node.callee.property.name === "toLowerCase" || node.callee.property.name === "toUpperCase") &&
  isTrimMember(node.callee.object);

type VoScope = "vo" | "non-vo";

const getArgPrimitiveKind =
  (services: ParserServicesWithTypeInformation) => (arg: TSESTree.CallExpressionArgument) =>
    pipe(
      services.esTreeNodeToTSNodeMap.get(arg),
      (tsArg) => services.program.getTypeChecker().getTypeAtLocation(tsArg),
      getBarePrimitiveOrLiteralKind,
    );

const isValidationHelperCall = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) =>
  node.callee.type === AST_NODE_TYPES.Identifier &&
  VALIDATION_FN_RE.test(node.callee.name) &&
  pipe(
    O.fromNullable(node.arguments[0]),
    O.flatMap(getArgPrimitiveKind(services)),
    O.isSome,
  );

const checkLiteralNode = (
  node: TSESTree.Literal,
  program: ts.Program,
  voPatterns: ReadonlyArray<string>,
  voScope: VoScope,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(
    "regex" in node &&
      Boolean(node.regex) &&
      voScope === "non-vo" &&
      ((isInsideFunctionLike(node) && isRegexValidationCall(node)) ||
        isDuplicatedNonVoRegex(node.raw, program, voPatterns)),
  )
    .with(true, () => {
      report({ node, messageId: "scatteredRegex", data: { pattern: node.raw } });
    })
    .with(false, () => {})
    .exhaustive();
};

const reportValidationHelper = (
  node: TSESTree.CallExpression,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(node.callee)
    .with({ type: AST_NODE_TYPES.Identifier }, (id) => {
      report({ node, messageId: "scatteredValidationCall", data: { name: id.name } });
    })
    .with(P._, () => {})
    .exhaustive();
};

const checkCallNode = (
  node: TSESTree.CallExpression,
  voScope: VoScope,
  services: ParserServicesWithTypeInformation,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match({
    voScope,
    isNorm: isTrimCaseChain(node),
    isVal: isValidationHelperCall(node, services),
  })
    .with({ voScope: "non-vo", isNorm: true }, () => { report({ node, messageId: "scatteredNormalization" }); })
    .with({ voScope: "non-vo", isVal: true }, () => { reportValidationHelper(node, report); })
    .with(P._, () => {})
    .exhaustive();
};

const getVoScope = (
  node: TSESTree.Node,
  fileName: string,
  voPatterns: ReadonlyArray<string>,
  services: ParserServicesWithTypeInformation,
) =>
  isInsideVoFactory(node, fileName, voPatterns, services)
    ? ("vo" as const)
    : ("non-vo" as const);

export const noScatteredValidation = createRule<Options, MessageIds>({
  name: "no-scattered-validation",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Detect validation regexes, normalization chains (`.trim().toLowerCase()`), and validation helper calls scattered outside Value Object constructors or factories.",
    },
    messages: {
      scatteredRegex:
        "Validation regex `{{pattern}}` appears outside a Value Object factory/constructor. Encapsulate invariant checks inside a self-validating Value Object.",
      scatteredNormalization:
        "String normalization `.trim().toLowerCase()/toUpperCase()` outside a Value Object leaks domain canonicalization. Move it into a Value Object constructor/factory.",
      scatteredValidationCall:
        "Primitive validation call `{{name}}(...)` outside a Value Object suggests an unencapsulated domain invariant.",
    },
    schema: [
      {
        type: "object",
        properties: {
          valueObjectPathPatterns: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ valueObjectPathPatterns: DEFAULT_VO_PATHS }],
  },
  create: (context, [options]) => {
    const services = ESLintUtils.getParserServices(context);
    const resolveScope = (node: TSESTree.Node) =>
      getVoScope(node, context.filename, options.valueObjectPathPatterns, services);
    const report = (d: TSESLint.ReportDescriptor<MessageIds>) => { context.report(d); };
    return {
      Literal: (node) => {
        checkLiteralNode(node, services.program, options.valueObjectPathPatterns, resolveScope(node), report);
      },
      CallExpression: (node) => { checkCallNode(node, resolveScope(node), services, report); },
    };
  },
});
