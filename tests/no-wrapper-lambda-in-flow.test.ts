import { noWrapperLambdaInFlow } from "../src/rules/no-wrapper-lambda-in-flow.js";
import { createRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();

ruleTester.run("no-wrapper-lambda-in-flow", noWrapperLambdaInFlow, {
  valid: [
    // Already curried / point-free
    `const f = flow(validate(ctx), RA.map(format(locale)), O.fromNullable);`,
    // Single-arg wrapper is handled by prefer-point-free, not this rule
    `const f = flow((x: number) => fn(x), RA.map((y: number) => g(y)));`,
    // Outside flow() and fp-ts combinators
    `const f = (x: number) => fn(x, ctx);`,
    `const f = [1, 2, 3].map((x) => fn(x, ctx));`,
    // Parameter transformed or used multiple times
    `const f = flow((x: User) => fn(x.id, ctx));`,
    `const f = RA.map((x: number) => fn(x, x));`,
    `const f = O.flatMap((x: number) => fn(x, x + 1));`,
    // Method call on parameter
    `const f = flow((x: Item) => x.format(ctx));`,
    // Parameter not forwarded
    `const f = flow((x: number) => fn(a, b));`,
    // Multi-parameter lambda
    `const f = flow((a: number, b: number) => fn(a, b));`,
  ],
  invalid: [
    {
      code: `const f = flow((x) => fn(x, ctx));`,
      errors: [{ messageId: "noWrapperLambdaInFlow" }],
    },
    {
      code: `const f = flow((x) => fn(ctx, x));`,
      errors: [{ messageId: "noWrapperLambdaInFlow" }],
    },
    {
      code: `const f = flow(a, (x) => fn(a, x, b), c);`,
      errors: [{ messageId: "noWrapperLambdaInFlow" }],
    },
    {
      code: `const f = flow((x) => { return fn(x, ctx); });`,
      errors: [{ messageId: "noWrapperLambdaInFlow" }],
    },
    {
      code: `const f = flow(function (x) { return fn(ctx, x); });`,
      errors: [{ messageId: "noWrapperLambdaInFlow" }],
    },
    {
      code: `const f = RA.map((x) => transform(x, ctx));`,
      errors: [{ messageId: "noWrapperLambdaInFlow" }],
    },
    {
      code: `const f = RA.filter((x) => isAllowed(rules, x));`,
      errors: [{ messageId: "noWrapperLambdaInFlow" }],
    },
    {
      code: `const f = O.map((x) => enrich(x, env));`,
      errors: [{ messageId: "noWrapperLambdaInFlow" }],
    },
    {
      code: `const f = O.flatMap((x) => lookup(repo, x));`,
      errors: [{ messageId: "noWrapperLambdaInFlow" }],
    },
    {
      code: `const f = E.map((x) => formatError(locale, x));`,
      errors: [{ messageId: "noWrapperLambdaInFlow" }],
    },
    {
      code: `const f = flow(RA.map((x) => fn(x, ctx)), O.fromNullable);`,
      errors: [{ messageId: "noWrapperLambdaInFlow" }],
    },
    {
      code: `const f = flow(map((x) => fn(ctx, x)));`,
      errors: [{ messageId: "noWrapperLambdaInFlow" }],
    },
  ],
});
