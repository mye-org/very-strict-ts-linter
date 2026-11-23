# @mye-org/eslint-plugin-strict-fp

A very strict TypeScript ESLint plugin enforcing functional programming style (`fp-ts`, `ts-pattern`, `monocle-ts`, `newtype-ts`) and Domain-Driven Design (DDD) architectural boundaries across three progressive tiers.

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

Running raw `eslint .` evaluates all 3 tiers at once, which can drown out structural and type-safety issues in style diagnostics. `strict-fp-lint` runs ESLint in **phased tiers**, stopping at the first tier with errors:

1. **Tier 1 (Architecture & DDD)** — Domain layer purity, functional core / imperative shell boundaries (`functional-core-boundary`), module cohesion (`module-cohesion`), encapsulation (`no-single-caller-export`), common reuse cohesion (`common-reuse-cohesion`), aggregate boundaries, value objects, ubiquitous language, DDD discovery rules, and FP abstraction discovery rules (`prefer-reader-over-context-drilling`, `no-structural-skeleton-duplication`, `prefer-catamorphism-over-recursive-adt-walk`).
2. **Tier 2 (Type Safety & Correctness)** — No `any`/`unknown`, no `null`/`undefined`, exhaustive matching, readonly collections, `@typescript-eslint/strict-type-checked`.
3. **Tier 3 (FP & Style)** — `fp-ts` conventions, no `let`/`var`, no imperative loops, no `if`/`else`/`switch`, point-free & monadic composition, `monocle-ts` optics (`prefer-lens-over-nested-spread`, `prefer-prism-over-guarded-update`, `prefer-traversal-over-nested-collection-update`), algebraic laws (`prefer-applicative-over-independent-bind`, `prefer-traverse-over-map-sequence`, `prefer-functor-fusion`), and max function lines.

## CLI Reference

### `strict-fp-init`

Scaffolds `eslint.config.ts` and sets `"lint": "strict-fp-lint"` in `package.json`.

```bash
npx strict-fp-init [options]
```

Options:
- `--max-tier <1|2|3>` — Maximum lint tier to configure in `eslint.config.ts` (default: `3`)
- `--force`, `-f` — Overwrite an existing `eslint.config.ts`
- `--cwd <dir>` — Target project directory (default: current directory)
- `--help`, `-h` — Show help

### `strict-fp-lint`

Primary phased lint runner.

```bash
npx strict-fp-lint [options] [paths...]
```

Options:
- `--tier <1|2|3>` — Run only a specific tier
- `--max-tier <1|2|3>` — Stop after the given tier (default: `3`)
- `--fix` — Automatically fix fixable issues
- `--format <name>` — ESLint formatter name (default: `stylish`)

### `strict-fp-radar`

Scans a TypeScript project and reports DDD and FP refactoring opportunities.

```bash
npx strict-fp-radar [--tsconfig tsconfig.json] [--format markdown|json]
```

## Configuration (`eslint.config.ts`)

`strictFp.createStrictFpConfig(options)` accepts:

- `files` — Target glob patterns (default: `["**/*.ts"]`)
- `boundaryFiles` — Imperative shell / CLI / infrastructure globs where boundary-specific rules (including `functional-core-boundary`) are relaxed
- `testFiles` — Test file globs where test-ergonomic relaxations apply (also forwarded as `testPatterns` to `no-single-caller-export` and `common-reuse-cohesion`)
- `domainFiles` — Domain layer globs for `domain-layer-purity` and `ubiquitous-language`
- `applicationFiles` — Application layer globs for `ubiquitous-language`
- `entryPoints` — Public API entry point globs forwarded to `no-single-caller-export` so transitively re-exported symbols are exempt from single-caller checks
- `maxFunctionLines` — Maximum lines per function for `max-function-lines` (default: `15`)
- `maxTier` — `1 | 2 | 3` (default: `3`)

By default, `**/*.tsx` and `**/*.config.ts` are excluded from strict `.ts` domain/type-safety/FP rules, while Tier 1 enforces `no-react-in-ts` on `.ts` files and `thin-react-component` on `.tsx` files (excluding `*.test.tsx`, `*.spec.tsx`, and `*.stories.tsx`).
