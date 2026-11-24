import { preferDoNotation } from "../src/rules/prefer-do-notation.js";
import { createRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();

ruleTester.run("prefer-do-notation", preferDoNotation, {
  valid: [
    // Proper Do-notation usage
    `
      const fn = flow(
        O.Do,
        O.bind("sym", () => getSymbol()),
        O.let("valueDecl", ({ sym }) => getValueDecl(sym)),
        O.map(({ sym, valueDecl }) => format(sym, valueDecl)),
      );
    `,
    // Single step constructing an object without a following destructuring step
    `
      const toRecord = flow(
        (name: string) => ({ name, role: "member" }),
      );
    `,
    // Next step does not unpack via ObjectPattern
    `
      const fn = flow(
        (sym: Symbol) => ({ sym, valueDecl: getValueDecl(sym) }),
        (entry) => serialize(entry),
      );
    `,
    // Next step unpacks unrelated keys
    `
      const fn = flow(
        (sym: Symbol) => ({ sym, valueDecl: getValueDecl(sym) }),
        ({ other, another }: { other: string; another: string }) => combine(other, another),
      );
    `,
    // Object literal does not forward the input parameter
    `
      const fn = flow(
        (id: string) => ({ a: lookupA(), b: lookupB() }),
        ({ a, b }) => combine(a, b),
      );
    `,
  ],
  invalid: [
    // Direct flow steps packing and unpacking context
    {
      code: `
        const fn = flow(
          (sym: Symbol) => ({ sym, valueDecl: getValueDecl(sym) }),
          ({ sym, valueDecl }) => format(sym, valueDecl),
        );
      `,
      errors: [{ messageId: "preferDoNotation" }],
    },
    // Chained O.map lambdas inside flow(...)
    {
      code: `
        const fn = flow(
          O.map((sym: Symbol) => ({ sym, valueDecl: getValueDecl(sym) })),
          O.map(({ sym, valueDecl }) => format(sym, valueDecl)),
        );
      `,
      errors: [{ messageId: "preferDoNotation" }],
    },
    // Chained E.map + E.flatMap lambdas inside flow(...)
    {
      code: `
        const fn = flow(
          E.map((user: User) => ({ user, profile: loadProfile(user) })),
          E.flatMap(({ user, profile }) => save(user, profile)),
        );
      `,
      errors: [{ messageId: "preferDoNotation" }],
    },
    // Block body return in packing step
    {
      code: `
        const fn = flow(
          O.map((sym: Symbol) => {
            return { sym, valueDecl: getValueDecl(sym) };
          }),
          O.map(({ sym, valueDecl }) => format(sym, valueDecl)),
        );
      `,
      errors: [{ messageId: "preferDoNotation" }],
    },
    // Spread forwarding context to next step
    {
      code: `
        const fn = flow(
          O.map((ctx: Ctx) => ({ ...ctx, valueDecl: getValueDecl(ctx.sym) })),
          O.map(({ sym, valueDecl }) => format(sym, valueDecl)),
        );
      `,
      errors: [{ messageId: "preferDoNotation" }],
    },
  ],
});
