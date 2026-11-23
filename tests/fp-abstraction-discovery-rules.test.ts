import { noStructuralSkeletonDuplication } from "../src/rules/no-structural-skeleton-duplication.js";
import { preferCatamorphismOverRecursiveAdtWalk } from "../src/rules/prefer-catamorphism-over-recursive-adt-walk.js";
import { preferReaderOverContextDrilling } from "../src/rules/prefer-reader-over-context-drilling.js";
import { createTypeAwareRuleTester } from "./rule-tester.js";

const typeAwareRuleTester = createTypeAwareRuleTester();

typeAwareRuleTester.run(
  "prefer-reader-over-context-drilling",
  preferReaderOverContextDrilling,
  {
    valid: [
      // Only 2 forwarding hops (below default minDepth: 3)
      `
        type AppEnv = { readonly apiUrl: string; readonly timeoutMs: number };
        const leaf = (env: AppEnv) => env.apiUrl;
        const mid = (env: AppEnv) => leaf(env);
        const top = (env: AppEnv) => mid(env);
      `,
      // Intermediate function actually reads from env, so not pure drilling
      `
        type AppEnv = { readonly apiUrl: string; readonly timeoutMs: number };
        const d = (env: AppEnv) => env.apiUrl;
        const c = (env: AppEnv) => env.timeoutMs > 0 ? d(env) : "";
        const b = (env: AppEnv) => c(env);
        const a = (env: AppEnv) => b(env);
      `,
      // Primitive parameter forwarding is excluded
      `
        const d = (id: string) => id.trim();
        const c = (id: string) => d(id);
        const b = (id: string) => c(id);
        const a = (id: string) => b(id);
      `,
    ],
    invalid: [
      {
        code: `
          type AppEnv = { readonly apiUrl: string; readonly timeoutMs: number };
          const fetchLeaf = (env: AppEnv) => env.apiUrl;
          const step3 = (env: AppEnv) => fetchLeaf(env);
          const step2 = (env: AppEnv) => step3(env);
          const step1 = (env: AppEnv) => step2(env);
        `,
        errors: [{ messageId: "contextDrilling" }],
      },
      {
        code: `
          type Deps = { readonly clock: () => number; readonly prefix: string };
          function leaf(deps: Deps) { return deps.prefix; }
          function middle(deps: Deps) { return leaf(deps); }
          function entry(deps: Deps) { return middle(deps); }
        `,
        options: [{ minDepth: 2 }],
        errors: [{ messageId: "contextDrilling" }],
      },
    ],
  },
);

typeAwareRuleTester.run(
  "no-structural-skeleton-duplication",
  noStructuralSkeletonDuplication,
  {
    valid: [
      // Single occurrence is fine
      `
        declare const pipe: (...args: ReadonlyArray<unknown>) => unknown;
        declare const TE: {
          tryCatch: (a: unknown, b: unknown) => unknown;
          flatMap: (f: unknown) => unknown;
          map: (f: unknown) => unknown;
          mapLeft: (f: unknown) => unknown;
        };
        const loadOrder = (id: string) =>
          pipe(
            TE.tryCatch(() => id, (e: unknown) => e),
            TE.flatMap((x: unknown) => x),
            TE.map((x: unknown) => x),
            TE.mapLeft((e: unknown) => e),
          );
      `,
      // Short 2-step pipeline below default minSteps: 4
      `
        declare const pipe: (...args: ReadonlyArray<unknown>) => unknown;
        declare const O: { map: (f: unknown) => unknown; getOrElse: (f: unknown) => unknown };
        const a = (x: unknown) => pipe(x, O.map((v: unknown) => v), O.getOrElse(() => 0));
        const b = (x: unknown) => pipe(x, O.map((v: unknown) => v), O.getOrElse(() => 1));
      `,
      // Repeated same combinator (only 1 distinct combinator, below minDistinctCombinators: 3)
      `
        declare const pipe: (...args: ReadonlyArray<unknown>) => unknown;
        declare const O: { Do: unknown; apS: (k: string, v: unknown) => unknown };
        const a = () => pipe(O.Do, O.apS("a", 1), O.apS("b", 2), O.apS("c", 3), O.apS("d", 4));
        const b = () => pipe(O.Do, O.apS("x", 1), O.apS("y", 2), O.apS("z", 3), O.apS("w", 4));
      `,
    ],
    invalid: [
      {
        code: `
          declare const pipe: (...args: ReadonlyArray<unknown>) => unknown;
          declare const TE: {
            tryCatch: (a: unknown, b: unknown) => unknown;
            flatMap: (f: unknown) => unknown;
            map: (f: unknown) => unknown;
            mapLeft: (f: unknown) => unknown;
          };
          const loadOrder = (id: string) =>
            pipe(
              TE.tryCatch(() => id, (e: unknown) => e),
              TE.flatMap((x: unknown) => x),
              TE.map((x: unknown) => x),
              TE.mapLeft((e: unknown) => e),
            );
          const loadInvoice = (id: string) =>
            pipe(
              TE.tryCatch(() => id, (e: unknown) => e),
              TE.flatMap((x: unknown) => x),
              TE.map((x: unknown) => x),
              TE.mapLeft((e: unknown) => e),
            );
        `,
        errors: [
          { messageId: "structuralSkeletonDuplication" },
          { messageId: "structuralSkeletonDuplication" },
        ],
      },
    ],
  },
);

typeAwareRuleTester.run(
  "prefer-catamorphism-over-recursive-adt-walk",
  preferCatamorphismOverRecursiveAdtWalk,
  {
    valid: [
      // Only one recursive walker is fine
      `
        type Expr =
          | { readonly _tag: "Lit"; readonly value: number }
          | { readonly _tag: "Add"; readonly left: Expr; readonly right: Expr };
        const evalExpr = (expr: Expr): number =>
          expr._tag === "Lit" ? expr.value : evalExpr(expr.left) + evalExpr(expr.right);
      `,
      // fold* / cata* combinators are exempt
      `
        type Expr =
          | { readonly _tag: "Lit"; readonly value: number }
          | { readonly _tag: "Add"; readonly left: Expr; readonly right: Expr };
        const foldExpr = <R>(expr: Expr, alg: { readonly Lit: (n: number) => R; readonly Add: (l: R, r: R) => R }): R =>
          expr._tag === "Lit" ? alg.Lit(expr.value) : alg.Add(foldExpr(expr.left, alg), foldExpr(expr.right, alg));
        const evalExpr = (expr: Expr): number =>
          expr._tag === "Lit" ? expr.value : evalExpr(expr.left) + evalExpr(expr.right);
      `,
      // Non-recursive discriminated union
      `
        type Shape =
          | { readonly kind: "Circle"; readonly r: number }
          | { readonly kind: "Square"; readonly s: number };
        const area = (s: Shape) => (s.kind === "Circle" ? s.r * s.r : s.s * s.s);
        const perimeter = (s: Shape) => (s.kind === "Circle" ? 2 * s.r : 4 * s.s);
      `,
    ],
    invalid: [
      {
        code: `
          type Expr =
            | { readonly _tag: "Lit"; readonly value: number }
            | { readonly _tag: "Add"; readonly left: Expr; readonly right: Expr };
          const evalExpr = (expr: Expr): number =>
            expr._tag === "Lit" ? expr.value : evalExpr(expr.left) + evalExpr(expr.right);
          const formatExpr = (expr: Expr): string =>
            expr._tag === "Lit" ? String(expr.value) : "(" + formatExpr(expr.left) + "+" + formatExpr(expr.right) + ")";
        `,
        errors: [
          { messageId: "preferCatamorphism" },
          { messageId: "preferCatamorphism" },
        ],
      },
    ],
  },
);
