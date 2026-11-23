import { preferApplicativeOverIndependentBind } from "../src/rules/prefer-applicative-over-independent-bind.js";
import { preferFunctorFusion } from "../src/rules/prefer-functor-fusion.js";
import { preferTraverseOverMapSequence } from "../src/rules/prefer-traverse-over-map-sequence.js";
import { createRuleTester } from "./rule-tester.js";

const ruleTester = createRuleTester();

ruleTester.run(
  "prefer-applicative-over-independent-bind",
  preferApplicativeOverIndependentBind,
  {
    valid: [
      `
        const res = pipe(
          O.Do,
          O.apS("a", getA()),
          O.apS("b", getB()),
        );
      `,
      `
        const res = pipe(
          O.Do,
          O.apS("a", getA()),
          O.bind("b", ({ a }) => getBFrom(a)),
        );
      `,
      `
        const res = pipe(
          O.some(1),
          O.flatMap((x) => O.some(x + 1)),
        );
      `,
      // Effectful TE.flatMap(() => ...) may intentionally enforce sequential effect ordering
      `
        const res = pipe(
          saveOrder(),
          TE.flatMap(() => emitAuditEvent()),
        );
      `,
    ],
    invalid: [
      {
        code: `
          const res = pipe(
            O.Do,
            O.apS("a", getA()),
            O.bind("b", () => getB()),
          );
        `,
        errors: [{ messageId: "independentBind" }],
      },
      {
        code: `
          const res = pipe(
            E.Do,
            E.apS("a", parseA()),
            E.bind("b", (_scope) => parseB()),
          );
        `,
        errors: [{ messageId: "independentBind" }],
      },
      {
        code: `
          const res = pipe(
            TE.Do,
            TE.apS("a", fetchA()),
            TE.bindW("b", () => fetchB()),
          );
        `,
        errors: [{ messageId: "independentBind" }],
      },
      {
        code: `
          const res = pipe(
            O.some(1),
            O.flatMap(() => O.some(2)),
          );
        `,
        errors: [{ messageId: "independentFlatMap" }],
      },
      {
        code: `
          const res = pipe(
            E.right(1),
            E.flatMap((_unused) => E.right(2)),
          );
        `,
        errors: [{ messageId: "independentFlatMap" }],
      },
    ],
  },
);

ruleTester.run(
  "prefer-traverse-over-map-sequence",
  preferTraverseOverMapSequence,
  {
    valid: [
      `const res = pipe(xs, O.traverseArray(parseItem));`,
      `const res = pipe(xs, RA.traverse(E.Applicative)(validate));`,
      `const total = pipe(xs, RA.reduce(0, (acc, x) => acc + x));`,
      `const res = pipe(xs, RA.map(format), RA.filter(isNonEmpty));`,
    ],
    invalid: [
      {
        code: `const res = pipe(xs, RA.map(parseItem), O.sequenceArray);`,
        errors: [{ messageId: "mapThenSequence" }],
      },
      {
        code: `const res = pipe(xs, RA.map(validate), E.sequenceArray);`,
        errors: [{ messageId: "mapThenSequence" }],
      },
      {
        code: `const res = pipe(xs, RA.map(loadItem), TE.sequenceSeqArray);`,
        errors: [{ messageId: "mapThenSequence" }],
      },
      {
        code: `const res = flow(RA.map(parseItem), RA.sequence(O.Applicative));`,
        errors: [{ messageId: "mapThenSequence" }],
      },
      {
        code: `
          const res = pipe(
            xs,
            RA.reduce(O.some([] as ReadonlyArray<number>), (acc, x) => acc),
          );
        `,
        errors: [{ messageId: "manualMonadicReduce" }],
      },
      {
        code: `
          const res = pipe(
            xs,
            RA.reduce(E.right([]), (acc, x) => acc),
          );
        `,
        errors: [{ messageId: "manualMonadicReduce" }],
      },
    ],
  },
);

ruleTester.run("prefer-functor-fusion", preferFunctorFusion, {
  valid: [
    `const res = pipe(O.some(1), O.map(flow(inc, double)));`,
    `const res = pipe(xs, RA.filter(isActive), RA.map(getName));`,
    `const res = pipe(xs, RA.filterMap(parseActiveName));`,
    `const res = pipe(O.some(xs), O.map(RA.map(inc)));`,
  ],
  invalid: [
    {
      code: `const res = pipe(O.some(1), O.map(inc), O.map(double));`,
      errors: [{ messageId: "consecutiveMap" }],
    },
    {
      code: `const res = flow(RA.map(inc), RA.map(double));`,
      errors: [{ messageId: "consecutiveMap" }],
    },
    {
      code: `const res = pipe(E.right(1), E.map((x) => x + 1), E.map((x) => x * 2));`,
      errors: [{ messageId: "consecutiveMap" }],
    },
    {
      code: `const res = pipe(xs, RA.filter((x) => x > 0), RA.map((x) => x * 2));`,
      errors: [{ messageId: "filterThenMap" }],
    },
    {
      code: `const res = pipe(opts, RA.filter(O.isSome), RA.map((o) => o.value));`,
      errors: [{ messageId: "filterThenMap" }],
    },
  ],
});
