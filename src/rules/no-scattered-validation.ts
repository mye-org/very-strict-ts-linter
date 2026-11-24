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

const toRegexEntry = (node: ts.Node) =>
  ts.isRegularExpressionLiteral(node)
    ? O.some({ text: node.text, file: node.getSourceFile().fileName })
    : O.none;

const collectFileRegexes = flow(
  (sf: ts.SourceFile) => collectTsNodes(sf)(sf),
  RA.filterMap(toRegexEntry),
);

const resolveProgramRegexes = memoizeByProgram(regexCountCache)(
  flow(collectProjectSourceFiles, RA.flatMap(collectFileRegexes)),
);

const countUniqueFiles = flow(RA.uniq(S.Eq), RA.size);

const collectMatchingRegexFiles = (
  pattern: string,
  env: ValidationEnv,
) =>
  RA.filterMap((entry: Readonly<Record<"text" | "file", string>>) =>
    entry.text === pattern && !isMatchingAnyPattern(env.voPatterns)(entry.file)
      ? O.some(entry.file)
      : O.none,
  )(resolveProgramRegexes(env.services.program));

const isDuplicatedNonVoRegex = (
  pattern: string,
  env: ValidationEnv,
) => countUniqueFiles(collectMatchingRegexFiles(pattern, env)) >= 2;

const isFunctionLikeAstNode = (p: TSESTree.Node) =>
  p.type === AST_NODE_TYPES.FunctionDeclaration ||
  p.type === AST_NODE_TYPES.FunctionExpression ||
  p.type === AST_NODE_TYPES.ArrowFunctionExpression ||
  p.type === AST_NODE_TYPES.MethodDefinition;

const isFunctionLikeOrAncestor = (p: TSESTree.Node) =>
  isFunctionLikeAstNode(p) || isInsideFunctionLike(p);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const isInsideFunctionLike = (node: TSESTree.Node): boolean =>
  node.parent ? isFunctionLikeOrAncestor(node.parent) : false;

const isConstructorDefinition = (node: TSESTree.Node) =>
  node.type === AST_NODE_TYPES.MethodDefinition && node.kind === "constructor";

const isConstructorMethod = (fn: TSESTree.Node) =>
  isConstructorDefinition(fn) || O.exists(isConstructorDefinition)(O.fromNullable(fn.parent));

const isBrandedOrContainsBranded = (retType: ts.Type, checker: ts.TypeChecker) =>
  isBrandedOrNewtypeTsType(retType) ||
  RA.some(isBrandedOrNewtypeTsType)(unwrapContainerTsTypes(checker)(retType));

const isBrandedSignature = (sig: ts.Signature, checker: ts.TypeChecker) =>
  isBrandedOrContainsBranded(checker.getReturnTypeOfSignature(sig), checker);

const lookupSignature = (checker: ts.TypeChecker) =>
  flow(
    (sigDecl: ts.SignatureDeclaration) => checker.getSignatureFromDeclaration(sigDecl),
    O.fromNullable,
  );

const resolveFunctionLikeTsNode = (
  fn: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => O.fromPredicate(ts.isFunctionLike)(services.esTreeNodeToTSNodeMap.get(fn));

const resolveFunctionSignature = (
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  flow(
    (fn: TSESTree.Node) => resolveFunctionLikeTsNode(fn, services),
    O.flatMap(lookupSignature(checker)),
  );

const hasBrandedReturnType = (
  fn: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  return O.exists((sig: ts.Signature) => isBrandedSignature(sig, checker))(
    resolveFunctionSignature(services, checker)(fn),
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

type ValidationEnv = Readonly<{
  readonly sourceFile: ts.SourceFile;
  readonly voPatterns: ReadonlyArray<string>;
  readonly services: ParserServicesWithTypeInformation;
  readonly report: (d: TSESLint.ReportDescriptor<MessageIds>) => void;
}>;

const isInsideVoFactory = (node: TSESTree.Node, env: ValidationEnv) =>
  isMatchingAnyPattern(env.voPatterns)(env.sourceFile.fileName) || hasVoFactoryAncestor(node, env.services);

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

const resolveFirstArgKind = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) => O.flatMap(resolveArgPrimitiveKind(services))(O.fromNullable(node.arguments[0]));

const isValidationHelperCall = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) =>
  node.callee.type === AST_NODE_TYPES.Identifier &&
  isValidationFnName(node.callee.name) &&
  O.isSome(resolveFirstArgKind(node, services));

const isRegexLiteral = (node: TSESTree.Literal) => "regex" in node && Boolean(node.regex);

const isScatteredRegexLiteral = (
  node: TSESTree.Literal,
  target: Readonly<{ readonly voScope: VoScope; readonly env: ValidationEnv }>,
) =>
  isRegexLiteral(node) &&
  target.voScope === "non-vo" &&
  ((isInsideFunctionLike(node) && isRegexValidationCall(node)) ||
    isDuplicatedNonVoRegex(node.raw, target.env));

const checkLiteralNode = (
  env: ValidationEnv,
) => (
  node: TSESTree.Literal,
  voScope: VoScope,
) => {
  match(isScatteredRegexLiteral(node, { voScope, env }))
    .with(true, () => {
      env.report({ node, messageId: "scatteredRegex", data: { pattern: node.raw } });
    })
    .with(false, () => {})
    .exhaustive();
};

const reportValidationCall = (
  node: TSESTree.CallExpression,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(node)
    .with({ callee: { type: AST_NODE_TYPES.Identifier } }, (matched) => {
      report({ node: matched, messageId: "scatteredValidationCall", data: { name: matched.callee.name } });
    })
    .with(P._, () => {})
    .exhaustive();
};

const checkCallNode = (
  env: ValidationEnv,
) => (
  node: TSESTree.CallExpression,
  voScope: VoScope,
) => {
  match({
    voScope,
    isNorm: isTrimCaseChain(node),
    isVal: isValidationHelperCall(node, env.services),
  })
    .with({ voScope: "non-vo", isNorm: true }, () => { env.report({ node, messageId: "scatteredNormalization" }); })
    .with({ voScope: "non-vo", isVal: true }, () => { reportValidationCall(node, env.report); })
    .with(P._, () => {})
    .exhaustive();
};

const resolveVoScope = (env: ValidationEnv) => (node: TSESTree.Node) =>
  isInsideVoFactory(node, env)
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
    const env: ValidationEnv = {
      sourceFile: services.esTreeNodeToTSNodeMap.get(context.sourceCode.ast).getSourceFile(),
      voPatterns: options.valueObjectPathPatterns,
      services,
      report: (d) => { context.report(d); },
    };
    const resolveScope = resolveVoScope(env);
    return {
      Literal: (node) => { checkLiteralNode(env)(node, resolveScope(node)); },
      CallExpression: (node) => { checkCallNode(env)(node, resolveScope(node)); },
    };
  },
});
