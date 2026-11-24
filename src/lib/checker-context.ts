import {
  ParserServices,
  ParserServicesWithTypeInformation,
  TSESTree,
} from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { flow } from "fp-ts/lib/function.js";
import * as ts from "typescript";

export type CheckerContext = Readonly<{
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
  resolveType: (node: TSESTree.Node) => ts.Type;
}>;

const hasTypeProgram = (services: ParserServices): services is ParserServicesWithTypeInformation =>
  Boolean(services.program);

const buildCheckerContext = (services: ParserServicesWithTypeInformation) => {
  const checker = services.program.getTypeChecker();
  return {
    services,
    checker,
    resolveType: flow(
      (node: TSESTree.Node) => services.esTreeNodeToTSNodeMap.get(node),
      (tsNode) => checker.getTypeAtLocation(tsNode),
    ),
  };
};

export const toCheckerContext = ((services: ParserServices) =>
  hasTypeProgram(services)
    ? O.some<CheckerContext>(buildCheckerContext(services))
    : O.none) satisfies (services: ParserServices) => O.Option<CheckerContext>;
