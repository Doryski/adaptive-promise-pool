# Contributing to adaptive-promise-pool

Thanks for your interest in contributing! This project welcomes issues, bug reports,
and pull requests.

## Project principles

This library is intentionally lean. Please keep changes aligned with these constraints:

- **Zero runtime dependencies.** The published package must not add any runtime deps.
  Dev-only tooling is fine.
- **TypeScript strict, no `any`.** Prefer type inference and generics over explicit
  annotations and assertions. `any` and unsafe `as` casts are not accepted.
- **No code comments.** The codebase deliberately avoids inline comments; favor clear
  names and small, composable functions instead.
- **Dual ESM + CJS, Node ≥ 18.** Don't introduce APIs that break either target or the
  minimum supported Node version.

## Development setup

This project uses [pnpm](https://pnpm.io) (`pnpm@9`).

```bash
pnpm install
```

> Note: `benchmarks/compare` is a separate workspace with its own heavy dependencies.
> You do not need to install it to develop the library — install and run only the root
> package unless you are specifically working on the comparison benchmarks.

## Quality checks

Before opening a pull request, make sure all of these pass:

```bash
pnpm type-check   # tsc --noEmit
pnpm lint        # eslint .
pnpm test        # vitest run --maxWorkers=1 --bail=5
pnpm build       # tsup dual ESM + CJS build
```

### Running tests

The test suite uses [Vitest](https://vitest.dev) with a dual-strategy command convention:

- **Targeted** (when changing fewer than ~5 files):

  ```bash
  vitest run --maxWorkers=1 --bail=5 <file-path>
  ```

- **Full suite**:

  ```bash
  pnpm test
  ```

The `--maxWorkers=1` flag keeps resource usage light and `--bail=5` stops after 5
failures. Tests remain isolated with no shared state.

## Pull request process

1. Fork the repository and create a feature branch.
2. Make your change, keeping it focused and small.
3. Ensure `pnpm type-check`, `pnpm lint`, `pnpm test`, and `pnpm build` all pass.
4. Add or update tests covering your change.
5. Open a pull request describing the motivation and the approach. Reference any related
   issue.

## Reporting bugs and requesting features

Use the GitHub issue templates for [bug reports](.github/ISSUE_TEMPLATE/bug_report.md)
and [feature requests](.github/ISSUE_TEMPLATE/feature_request.md). For a bug, a minimal
reproduction is the single most helpful thing you can provide.

## Code of conduct

By participating, you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).
