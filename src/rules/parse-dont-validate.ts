import {
  AST_NODE_TYPES,
  ESLintUtils,
  ParserServicesWithTypeInformation,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import { pipe } from "fp-ts/lib/function.js";
import { match, P } from "ts-pattern";
import * as ts from "typescript";
import { createRule } from "../utils/create-rule.js";
import {
  getEnclosingEsTreeFunction,
  isInsideUnsafeOrMustFunction,
  isTsParameterSymbol,
  isUnsafeOrMustName,
} from "../utils/type-helpers.js";

type MessageIds = "parseDontValidateFunction" | "noShotgunValidation";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const VALIDATE_NAME_RE = /^(validate|verify|assertValid|checkValid)(?=$|[A-Z0-9_])/;
const IS_VALID_NAME_RE = /^isValid(?=$|[A-Z0-9_])/;
const EXEMPT_DOMAIN_FN_RE = /^(parse|decode|from|make|create|is|has|can|should|validate|verify|assert|check)(?=$|[A-Z0-9_])/;
const SHOTGUN_RANGE_OPS = new Set(["<", "<=", ">", ">="]);

const getFunctionName = (node: FunctionNode) =>
  match(node)
    .with({ type: AST_NODE_TYPES.FunctionDeclaration }, (f) => O.fromNullable(f.id?.name))
    .with({ parent: { type: AST_NODE_TYPES.VariableDeclarator, id: { type: AST_NODE_TYPES.Identifier } } }, (f) =>
      O.some(f.parent.id.name),
    )
    .with({ parent: { type: AST_NODE_TYPES.Property, key: { type: AST_NODE_TYPES.Identifier } } }, (f) =>
      O.some(f.parent.key.name),
    )
    .with(P._, () => O.none)
    .exhaustive();

const isPrimitiveParam = (
  param: TSESTree.Parameter,
  services: ParserServicesWithTypeInformation,
) =>
  Boolean(
    services.program
      .getTypeChecker()
      .getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(param)).flags &
      (ts.TypeFlags.String | ts.TypeFlags.Number),
  );

const isBooleanVoidOrOption = (ret: ts.Type) =>
  Boolean(ret.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Void | ts.TypeFlags.Undefined)) ||
  ret.aliasSymbol?.name === "Option" ||
  ret.getSymbol()?.name === "Option";

const isInvalidValidateReturn = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
) =>
  node.returnType?.typeAnnotation.type !== AST_NODE_TYPES.TSTypePredicate &&
  pipe(
    services.program
      .getTypeChecker()
      .getSignatureFromDeclaration(services.esTreeNodeToTSNodeMap.get(node) as ts.SignatureDeclaration),
    O.fromNullable,
    O.map((sig) => services.program.getTypeChecker().getReturnTypeOfSignature(sig)),
    O.exists(isBooleanVoidOrOption),
  );

const hasPrimitiveParam = (
  params: ReadonlyArray<TSESTree.Parameter>,
  services: ParserServicesWithTypeInformation,
) => pipe(params, RA.some((p) => isPrimitiveParam(p, services)));

const isValidateWithoutParse = (
  node: FunctionNode,
  services: ParserServicesWithTypeInformation,
) =>
  pipe(
    getFunctionName(node),
    O.exists(
      (name) =>
        (VALIDATE_NAME_RE.test(name) ||
          (IS_VALID_NAME_RE.test(name) && hasPrimitiveParam(node.params, services))) &&
        isInvalidValidateReturn(node, services),
    ),
  );

const isShotgunEligibleContext = (node: TSESTree.Node) =>
  !isInsideUnsafeOrMustFunction(node) &&
  !pipe(
    getEnclosingEsTreeFunction(node),
    O.flatMap(getFunctionName),
    O.exists((name) => isUnsafeOrMustName(name) || EXEMPT_DOMAIN_FN_RE.test(name)),
  );

const isRawPrimitiveParamId = (
  expr: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
) => {
  const checker = services.program.getTypeChecker();
  const tsNode = services.esTreeNodeToTSNodeMap.get(expr);
  return (
    expr.type === AST_NODE_TYPES.Identifier &&
    pipe(O.fromNullable(checker.getSymbolAtLocation(tsNode)), O.exists(isTsParameterSymbol)) &&
    Boolean(checker.getTypeAtLocation(tsNode).flags & (ts.TypeFlags.String | ts.TypeFlags.Number))
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

const isShotgunMemberCall = (
  callee: TSESTree.MemberExpression,
  arg0: O.Option<TSESTree.CallExpressionArgument>,
  services: ParserServicesWithTypeInformation,
) =>
  callee.property.type === AST_NODE_TYPES.Identifier &&
  match(callee.property.name)
    .with("includes", () =>
      isRawPrimitiveParamId(callee.object, services) &&
      pipe(arg0, O.exists((a) => a.type === AST_NODE_TYPES.Literal && typeof a.value === "string")),
    )
    .with("test", () =>
      callee.object.type === AST_NODE_TYPES.Literal &&
      "regex" in callee.object &&
      pipe(arg0, O.exists((a) => isRawPrimitiveParamId(a, services))),
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
  pipe(msg, O.map((messageId) => { report({ node, messageId }); }));
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
