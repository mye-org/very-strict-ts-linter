import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESLint, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as S from "fp-ts/lib/string.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { memoizeByProgram } from "../lib/program-memo.js";
import { createRule } from "../lib/rule-factory.js";
import { collectProjectSourceFiles, isMatchingAnyPattern } from "../lib/source-paths.js";
import { unwrapContainerTsTypes } from "../lib/ts-container-types.js";
import { collectTsNodes } from "../lib/ts-node-traversal.js";
import { isBrandedOrNewtypeTsType, resolveBarePrimitiveOrLiteralKind } from "../lib/ts-primitive-types.js";

type Options = [Readonly<{ readonly valueObjectPathPatterns: ReadonlyArray<string> }>];
type MessageIds = "scatteredRegex" | "scatteredNormalization" | "scatteredValidationCall";

const DEFAULT_VO_PATHS = ["**/value-objects/**", "**/valueObjects/**", "**/vo/**"];
const VALIDATION_FN_RE = /^(isValid|validate|assertValid)[A-Z]/;
const VALIDATION_REGEX_METHODS: ReadonlySet<string> = new Set(["test", "match", "exec"]);
const TRIM_METHOD_NAMES: ReadonlySet<string> = new Set(["trim"]);
const CASE_METHOD_NAMES: ReadonlySet<string> = new Set(["toLowerCase", "toUpperCase"]);

const regexCountCache = new WeakMap<ts.Program, ReadonlyArray<Readonly<Record<"text" | "file", string>>>>();

const toRegexEntry = (file: string) => (node: ts.Node) =>
  ts.isRegularExpressionLiteral(node) ? O.some({ text: node.text, file }) : O.none;

const collectFileRegexes = (sf: ts.SourceFile) =>
  flow(
    (file: ts.SourceFile) => collectTsNodes(file, file),
    RA.filterMap(toRegexEntry(sf.fileName)),
  )(sf);

const resolveProgramRegexes = (program: ts.Program) =>
  memoizeByProgram(
    program,
    regexCountCache,
    flow(collectProjectSourceFiles, RA.flatMap(collectFileRegexes)),
  );

const isDuplicatedNonVoRegex = (
  pattern: string,
  program: ts.Program,
  voPatterns: ReadonlyArray<string>,
) =>
  flow(
    RA.filterMap((entry: Readonly<Record<"text" | "file", string>>) =>
      entry.text === pattern && !isMatchingAnyPattern(entry.file, voPatterns)
        ? O.some(entry.file)
        : O.none,
    ),
    RA.uniq(S.Eq),
    RA.size,
  )(resolveProgramRegexes(program)) >= 2;

const isFunctionLikeAstNode = (p: TSESTree.Node) =>
  p.type === AST_NODE_TYPES.FunctionDeclaration ||
  p.type === AST_NODE_TYPES.FunctionExpression ||
  p.type === AST_NODE_TYPES.ArrowFunctionExpression ||
  p.type === AST_NODE_TYPES.MethodDefinition;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const isInsideFunctionLike = (node: TSESTree.Node): boolean =>
  flow(
    (n: TSESTree.Node) => O.fromNullable(n.parent),
    O.exists((p) => isFunctionLikeAstNode(p) || isInsideFunctionLike(p)),
  )(node);

const isConstructorMethod = (fn: TSESTree.Node) =>
  (fn.type === AST_NODE_TYPES.MethodDefinition && fn.kind === "constructor") ||
  (fn.parent?.type === AST_NODE_TYPES.MethodDefinition && fn.parent.kind === "constructor");

const isBrandedOrContainsBranded = (retType: ts.Type, checker: ts.TypeChecker) =>
  isBrandedOrNewtypeTsType(retType) ||
  RA.some(isBrandedOrNewtypeTsType)(unwrapContainerTsTypes(retType, checker));

const isBrandedSignature = (sig: ts.Signature, checker: ts.TypeChecker) =>
  isBrandedOrContainsBranded(checker.getReturnTypeOfSignature(sig), checker);

const resolveFunctionSignature = (
  fn: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  O.fromNullable(
    checker.getSignatureFromDeclaration(
      services.esTreeNodeToTSNodeMap.get(fn) as ts.SignatureDeclaration,
    ),
  );

const hasBrandedReturnType = (
  fn: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  return O.exists((sig: ts.Signature) => isBrandedSignature(sig, checker))(
    resolveFunctionSignature(fn, services, checker),
  );
};

const hasVoFactoryAncestor = (
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
  // eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
): boolean =>
  O.exists(
    (p: TSESTree.Node) =>
      (isFunctionLikeAstNode(p) &&
        (isConstructorMethod(p) || hasBrandedReturnType(p, services))) ||
      hasVoFactoryAncestor(p, services),
  )(O.fromNullable(node.parent));

const isInsideVoFactory = (
  node: TSESTree.Node,
  fileName: string,
  voPatterns: ReadonlyArray<string>,
  services: ParserServicesWithTypeInformation,
) =>
  isMatchingAnyPattern(fileName, voPatterns) || hasVoFactoryAncestor(node, services);

const hasMemberPropertyIn = (
  member: TSESTree.MemberExpression,
  names: ReadonlySet<string>,
) => member.property.type === AST_NODE_TYPES.Identifier && names.has(member.property.name);

const isRegexValidationCall = (node: TSESTree.Literal) =>
  node.parent.type === AST_NODE_TYPES.MemberExpression &&
  node.parent.object === node &&
  hasMemberPropertyIn(node.parent, VALIDATION_REGEX_METHODS);

const isTrimMember = (expr: TSESTree.Expression) =>
  expr.type === AST_NODE_TYPES.CallExpression &&
  expr.callee.type === AST_NODE_TYPES.MemberExpression &&
  hasMemberPropertyIn(expr.callee, TRIM_METHOD_NAMES);

const isTrimCaseChain = (node: TSESTree.CallExpression) =>
  node.callee.type === AST_NODE_TYPES.MemberExpression &&
  hasMemberPropertyIn(node.callee, CASE_METHOD_NAMES) &&
  isTrimMember(node.callee.object);

type VoScope = "vo" | "non-vo";

const resolveArgPrimitiveKind = (services: ParserServicesWithTypeInformation) =>
  flow(
    (arg: TSESTree.CallExpressionArgument) => services.esTreeNodeToTSNodeMap.get(arg),
    (tsArg) => services.program.getTypeChecker().getTypeAtLocation(tsArg),
    resolveBarePrimitiveOrLiteralKind,
  );

const isValidationFnName = (name: string) => VALIDATION_FN_RE.test(name);

const isValidationHelperCall = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) =>
  node.callee.type === AST_NODE_TYPES.Identifier &&
  isValidationFnName(node.callee.name) &&
  flow(O.flatMap(resolveArgPrimitiveKind(services)), O.isSome)(
    O.fromNullable(node.arguments[0]),
  );

const isRegexLiteral = (node: TSESTree.Literal) => "regex" in node && Boolean(node.regex);

const isScatteredRegexLiteral = (
  node: TSESTree.Literal,
  program: ts.Program,
  voPatterns: ReadonlyArray<string>,
  voScope: VoScope,
) =>
  isRegexLiteral(node) &&
  voScope === "non-vo" &&
  ((isInsideFunctionLike(node) && isRegexValidationCall(node)) ||
    isDuplicatedNonVoRegex(node.raw, program, voPatterns));

const checkLiteralNode = (
  node: TSESTree.Literal,
  program: ts.Program,
  voPatterns: ReadonlyArray<string>,
  voScope: VoScope,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(isScatteredRegexLiteral(node, program, voPatterns, voScope))
    .with(true, () => {
      report({ node, messageId: "scatteredRegex", data: { pattern: node.raw } });
    })
    .with(false, () => {})
    .exhaustive();
};

const reportValidationCall = (
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
    .with({ voScope: "non-vo", isVal: true }, () => { reportValidationCall(node, report); })
    .with(P._, () => {})
    .exhaustive();
};

const resolveVoScope = (
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
      resolveVoScope(node, context.filename, options.valueObjectPathPatterns, services);
    const report = (d: TSESLint.ReportDescriptor<MessageIds>) => { context.report(d); };
    return {
      Literal: (node) => {
        checkLiteralNode(node, services.program, options.valueObjectPathPatterns, resolveScope(node), report);
      },
      CallExpression: (node) => { checkCallNode(node, resolveScope(node), services, report); },
    };
  },
});
