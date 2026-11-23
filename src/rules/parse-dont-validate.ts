import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { flow } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../lib/rule-factory.js";
import { isOptionTsType } from "../lib/ts-option-type.js";
import { isTsParameterSymbol } from "../lib/ts-parameter-symbol.js";
import { hasMatchingEnclosingFunctionName, isInsideUnsafeOrMustFunction, isUnsafeOrMustName } from "../lib/unsafe-function-scope.js";

type MessageIds = "parseDontValidateFunction" | "noShotgunValidation";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const VALIDATE_NAME_RE = /^(validate|verify|assertValid|checkValid)(?=$|[A-Z0-9_])/;
const IS_VALID_NAME_RE = /^isValid(?=$|[A-Z0-9_])/;
const EXEMPT_DOMAIN_FN_RE = /^(parse|decode|from|make|create|is|has|can|should|validate|verify|assert|check)(?=$|[A-Z0-9_])/;
const SHOTGUN_RANGE_OPS = new Set(["<", "<=", ">", ">="]);
const INCLUDES_METHODS: ReadonlySet<string> = new Set(["includes"]);
const TEST_METHODS: ReadonlySet<string> = new Set(["test"]);

const resolveParentBindingName = (parent: TSESTree.Node) =>
  match(parent)
    .with({ type: AST_NODE_TYPES.VariableDeclarator, id: { type: AST_NODE_TYPES.Identifier } }, (p) =>
      O.some(p.id.name),
    )
    .with({ type: AST_NODE_TYPES.Property, key: { type: AST_NODE_TYPES.Identifier } }, (p) =>
      O.some(p.key.name),
    )
    .with(P._, () => O.none)
    .exhaustive();

const resolveFunctionName = (node: FunctionNode) =>
  node.type === AST_NODE_TYPES.FunctionDeclaration
    ? O.fromNullable(node.id?.name)
    : O.flatMap(resolveParentBindingName)(O.fromNullable(node.parent));

const isStringOrNumberFlag = (flags: ts.TypeFlags) =>
  Boolean(flags & (ts.TypeFlags.String | ts.TypeFlags.Number));

const isBooleanOrVoidFlag = (flags: ts.TypeFlags) =>
  Boolean(
    flags &
      (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Void | ts.TypeFlags.Undefined),
  );

const isPrimitiveParam = (
  param: TSESTree.Parameter,
  services: ParserServicesWithTypeInformation,
) =>
  isStringOrNumberFlag(
    services.program
      .getTypeChecker()
      .getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(param)).flags,
  );

const isBooleanVoidOrOption = (ret: ts.Type) =>
  isBooleanOrVoidFlag(ret.flags) || isOptionTsType(ret);

const isTypePredicateAnnotation = O.exists(
  (r: TSESTree.TSTypeAnnotation) => r.typeAnnotation.type === AST_NODE_TYPES.TSTypePredicate,
);

const isInvalidValidateSignature = (sig: ts.Signature, checker: ts.TypeChecker) =>
  isBooleanVoidOrOption(checker.getReturnTypeOfSignature(sig));

const resolveFunctionSignature = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) =>
  O.fromNullable(
    checker.getSignatureFromDeclaration(
      services.esTreeNodeToTSNodeMap.get(node) as ts.SignatureDeclaration,
    ),
  );

const isInvalidValidateReturn = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  return (
    !isTypePredicateAnnotation(O.fromNullable(node.returnType)) &&
    O.exists((sig: ts.Signature) => isInvalidValidateSignature(sig, checker))(
      resolveFunctionSignature(node, services, checker),
    )
  );
};

const hasPrimitiveParam = (
  params: ReadonlyArray<TSESTree.Parameter>,
  services: ParserServicesWithTypeInformation,
) => RA.some((p: TSESTree.Parameter) => isPrimitiveParam(p, services))(params);

const isValidateFnName = (name: string) => VALIDATE_NAME_RE.test(name);
const isIsValidFnName = (name: string) => IS_VALID_NAME_RE.test(name);
const isExemptDomainFnName = (name: string) => EXEMPT_DOMAIN_FN_RE.test(name);

const isValidateWithoutParse = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
) =>
  O.exists(
    (name: string) =>
      (isValidateFnName(name) ||
        (isIsValidFnName(name) && hasPrimitiveParam(node.params, services))) &&
      isInvalidValidateReturn(node, services),
  )(resolveFunctionName(node));

const isShotgunEligibleContext = (node: TSESTree.Node) =>
  !isInsideUnsafeOrMustFunction(node) &&
  !hasMatchingEnclosingFunctionName(
    node,
    (name) => isUnsafeOrMustName(name) || isExemptDomainFnName(name),
  );

const isRawPrimitiveParamId = (
  expr: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  const tsNode = services.esTreeNodeToTSNodeMap.get(expr);
  return (
    expr.type === AST_NODE_TYPES.Identifier &&
    flow(
      (n: ts.Node) => checker.getSymbolAtLocation(n),
      O.fromNullable,
      O.exists(isTsParameterSymbol),
    )(tsNode) &&
    isStringOrNumberFlag(checker.getTypeAtLocation(tsNode).flags)
  );
};

const isZeroLiteral = (expr: TSESTree.Node) =>
  expr.type === AST_NODE_TYPES.Literal && expr.value === 0;

const isShotgunRangeCheck = (
  b: TSESTree.BinaryExpression,
  services: ParserServicesWithTypeInformation,
) =>
  SHOTGUN_RANGE_OPS.has(b.operator) &&
  ((isRawPrimitiveParamId(b.left, services) && isZeroLiteral(b.right)) ||
    (isRawPrimitiveParamId(b.right, services) && isZeroLiteral(b.left)));

const isStringLiteralArg = (a: TSESTree.CallExpressionArgument) =>
  a.type === AST_NODE_TYPES.Literal && typeof a.value === "string";

const isShotgunMemberCall = (
  callee: TSESTree.MemberExpression,
  arg0: O.Option<TSESTree.CallExpressionArgument>,
  services: ParserServicesWithTypeInformation,
) =>
  callee.property.type === AST_NODE_TYPES.Identifier &&
  match({
    isIncludes: INCLUDES_METHODS.has(callee.property.name),
    isTest: TEST_METHODS.has(callee.property.name),
  })
    .with({ isIncludes: true }, () =>
      isRawPrimitiveParamId(callee.object, services) && O.exists(isStringLiteralArg)(arg0),
    )
    .with({ isTest: true }, () =>
      callee.object.type === AST_NODE_TYPES.Literal &&
      "regex" in callee.object &&
      O.exists((a: TSESTree.CallExpressionArgument) => isRawPrimitiveParamId(a, services))(arg0),
    )
    .otherwise(() => false);

const isShotgunCallCheck = (
  c: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
) =>
  c.callee.type === AST_NODE_TYPES.MemberExpression &&
  isShotgunMemberCall(c.callee, O.fromNullable(c.arguments[0]), services);

const reportOpt = (
  node: TSESTree.Node,
  msg: O.Option<MessageIds>,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => void,
) => {
  O.map((messageId: MessageIds) => { report({ node, messageId }); })(msg);
};

export const parseDontValidate = createRule<[], MessageIds>({
  name: "parse-dont-validate",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce 'parse, don't validate': require smart constructors returning `Either<Err, Branded>` (or type predicates) instead of boolean/void/Option validators or shotgun checks on raw primitives.",
    },
    messages: {
      parseDontValidateFunction:
        "Parse, don't validate: return `Either<ValidationError, BrandedType>` (or a `x is Branded` type guard) so validated invariants are encoded in the output type.",
      noShotgunValidation:
        "Avoid shotgun validation on raw primitives inside domain functions. Parse once at the boundary into a branded `Newtype` and accept the refined type here.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const services = ESLintUtils.getParserServices(context);
    const rep = (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds }>) => { context.report(d); };
    const checkFn = (node: FunctionNode) => { reportOpt(node, isValidateWithoutParse(node, services) ? O.some("parseDontValidateFunction") : O.none, rep); };
    return {
      FunctionDeclaration: checkFn,
      FunctionExpression: checkFn,
      ArrowFunctionExpression: checkFn,
      BinaryExpression: (node) => { reportOpt(node, isShotgunEligibleContext(node) && isShotgunRangeCheck(node, services) ? O.some("noShotgunValidation") : O.none, rep); },
      CallExpression: (node) => { reportOpt(node, isShotgunEligibleContext(node) && isShotgunCallCheck(node, services) ? O.some("noShotgunValidation") : O.none, rep); },
    };
  },
});
