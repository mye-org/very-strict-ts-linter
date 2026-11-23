# @mye-org/eslint-plugin-strict-fp

A very strict TypeScript ESLint plugin enforcing TypeScript type soundness (`tsc --noEmit`), functional programming style (`fp-ts`, `ts-pattern`, `monocle-ts`, `newtype-ts`), and Domain-Driven Design (DDD) architectural boundaries across four progressive tiers (Tier 0–3).

## Quick Start

### 1. Install

```bash
npm install -D @mye-org/eslint-plugin-strict-fp eslint typescript jiti
# or
pnpm add -D @mye-org/eslint-plugin-strict-fp eslint typescript jiti
```

> `jiti` is used by ESLint 9 to load `eslint.config.ts`.

### 2. Initialize your project

Run `strict-fp-init` to scaffold `eslint.config.ts` and configure `"lint": "strict-fp-lint"` in your `package.json`:

```bash
npx strict-fp-init
```

This creates:
- `eslint.config.ts` wired up with `strictFp.createStrictFpConfig(...)` and `projectService: true`
- `"scripts": { "lint": "strict-fp-lint" }` in `package.json`

### 3. Run `strict-fp-lint` (Primary Entrypoint)

Use `strict-fp-lint` (via `npm run lint` / `pnpm lint`) as your primary lint entrypoint instead of `eslint .`:

```bash
npm run lint
# or directly:
npx strict-fp-lint
```

#### Why `strict-fp-lint` instead of `eslint .`?

Running raw `eslint .` skips TypeScript's compiler type checker (`tsc --noEmit`) and evaluates all ESLint tiers at once, which can drown out type-soundness and structural issues in style diagnostics. `strict-fp-lint` runs checks in **phased tiers**, stopping at the first tier with errors (default non-`--fix` runs execute ESLint in a single pass and partition diagnostics by tier, while `--fix` applies fixes tier by tier):

0. **Tier 0 (Type Checker — `tsc --noEmit`)** — Type soundness — *"Does this code obey TypeScript's type system?"* Runs `tsc --noEmit` first, before any ESLint rules.
1. **Tier 1 (Type Safety & Correctness)** — No `any`/`unknown`, no `null`/`undefined`, exhaustive matching, readonly collections, `@typescript-eslint/strict-type-checked`.
2. **Tier 2 (Architecture & DDD)** — Domain layer purity, functional core / imperative shell boundaries (`functional-core-boundary`), module cohesion (`module-cohesion`), encapsulation (`no-single-caller-export`), common reuse cohesion (`common-reuse-cohesion`), aggregate boundaries, value objects, ubiquitous language, React boundaries (`no-react-in-ts`, `thin-react-component`, `no-unsafe-react-hooks`, `require-js-thread-schedule-on-rn`), DDD discovery rules, FP abstraction discovery rules (`prefer-reader-over-context-drilling`, `no-structural-skeleton-duplication`, `prefer-catamorphism-over-recursive-adt-walk`), and TestScope compositional test rules (`no-redundant-test-scope`, `prefer-lowest-test-level`, `single-test-responsibility`).
3. **Tier 3 (FP & Style)** — `fp-ts` conventions (strictly `flow`-based composition), no `let`/`var`, no imperative loops, no `if`/`else`/`switch`, point-free & monadic composition, `monocle-ts` optics (`prefer-lens-over-nested-spread`, `prefer-prism-over-guarded-update`, `prefer-traversal-over-nested-collection-update`), algebraic laws (`prefer-applicative-over-independent-bind`, `prefer-traverse-over-map-sequence`, `prefer-functor-fusion`), and max function lines.

## CLI Reference

### `strict-fp-init`

Scaffolds `eslint.config.ts` and sets `"lint": "strict-fp-lint"` in `package.json`.

```bash
npx strict-fp-init [options]
```

Options:
- `--max-tier <0|1|2|3>` — Maximum lint tier to configure in `eslint.config.ts` (default: `3`)
- `--force`, `-f` — Overwrite an existing `eslint.config.ts`
- `--cwd <dir>` — Target project directory (default: current directory)
- `--help`, `-h` — Show help

### `strict-fp-lint`

Primary phased lint runner.

```bash
npx strict-fp-lint [options] [paths...]
```

Options:
- `--tier <0|1|2|3>` — Run only a specific tier (`0` runs `tsc --noEmit`)
- `--max-tier <0|1|2|3>` — Stop after the given tier (default: `3`)
- `--tsconfig <path>`, `--project <path>`, `-p <path>` — Path to `tsconfig.json` passed to `tsc --noEmit` in Tier 0
- `--fix` — Automatically fix fixable issues
- `--format <name>` — ESLint formatter name (default: `stylish`)
- `--no-cache` — Disable incremental `.tsbuildinfo` and content-hashed project caching (caching is enabled by default)
- `--cache-location <dir>`, `--cache-dir <dir>` — Custom directory for `.tsbuildinfo` and content-hashed cache artifacts (default: `node_modules/.cache/strict-fp`)
- `--eslint-cache` — Opt-in to ESLint's built-in content cache (`--cache --cache-strategy content`) for syntax-only workflows
- `--daemon` — Route linting through a persistent workspace daemon that keeps an incremental TypeScript `BuilderProgram` (Tier 0) and warm `ESLint` Project Service (Tiers 1–3) in memory across runs
- `--daemon-status` — Print status of the workspace daemon
- `--daemon-stop` — Stop the running workspace daemon

### `strict-fp-radar`

Scans a TypeScript project and reports DDD and FP refactoring opportunities using TypeScript's incremental builder (`ts.createIncrementalProgram`) and content-hashed report caching.

```bash
npx strict-fp-radar [--tsconfig tsconfig.json] [--format markdown|json] [--no-cache] [--cache-location <dir>]
```

## Configuration (`eslint.config.ts`)

`strictFp.createStrictFpConfig(options)` accepts:

- `files` — Target glob patterns (default: `["**/*.ts"]`)
- `boundaryFiles` — Imperative shell / CLI / infrastructure globs where boundary-specific rules (including `functional-core-boundary`) are relaxed
- `testFiles` — Test file globs where test-ergonomic relaxations apply (also forwarded as `testPatterns` to `no-single-caller-export`, `common-reuse-cohesion`, `no-redundant-test-scope`, `prefer-lowest-test-level`, and `single-test-responsibility`)
- `domainFiles` — Domain layer globs for `domain-layer-purity` and `ubiquitous-language`
- `applicationFiles` — Application layer globs for `ubiquitous-language`
- `entryPoints` — Public API entry point globs forwarded to `no-single-caller-export` so transitively re-exported symbols are exempt from single-caller checks
- `maxFunctionLines` — Maximum lines per function for `max-function-lines` (default: `15`)
- `maxTier` — `0 | 1 | 2 | 3` (default: `3`)

By default, `**/*.tsx` and `**/*.config.ts` are excluded from strict `.ts` type-safety/domain/FP rules, while Tier 2 enforces `no-react-in-ts` on `.ts` files and `no-sequences` + `thin-react-component` + `no-unsafe-react-hooks` + `require-js-thread-schedule-on-rn` on `.tsx` files (excluding `*.test.tsx`, `*.spec.tsx`, and `*.stories.tsx`).
