import { noSingleUseMicroFlow } from "../src/rules/no-single-use-micro-flow.js";
import { createRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();

ruleTester.run("no-single-use-micro-flow", noSingleUseMicroFlow, {
  valid: [
    // Exported helper is allowed
    `
      export const step = flow(a, b);
      const run = flow(step, c);
    `,
    // 3-step flow is not a 2-step micro-flow
    `
      const step = flow(a, b, c);
      const run = flow(step, d);
    `,
    // 1-step flow is not a 2-step micro-flow
    `
      const step = flow(a);
      const run = flow(step, d);
    `,
    // Referenced more than once
    `
      const step = flow(a, b);
      const run1 = flow(step, c);
      const run2 = flow(step, d);
    `,
    // Referenced outside a flow(...) call (direct invocation)
    `
      const step = flow(a, b);
      const result = step(x);
    `,
    // Exported via named export specifier
    `
      const step = flow(a, b);
      export { step };
    `,
    // Inside a function body (not module-level)
    `
      const outer = () => {
        const step = flow(a, b);
        return flow(step, c);
      };
    `,
    // Unused helper (0 references)
    `
      const step = flow(a, b);
    `,
  ],
  invalid: [
    {
      code: `
        const step = flow(a, b);
        const run = flow(step, c);
      `,
      errors: [{ messageId: "noSingleUseMicroFlow", data: { name: "step" } }],
    },
    {
      code: `
        const normalizeAndTrim = flow(normalize, trim);
        export const processInput = flow(parse, normalizeAndTrim, validate);
      `,
      errors: [{ messageId: "noSingleUseMicroFlow", data: { name: "normalizeAndTrim" } }],
    },
  ],
});
