[private]
default:
    @just --list

[doc("Run the TypeScript entrypoint with tsx")]
[group("dev")]
dev:
    npm run dev

[doc("Build the distributable package")]
[group("build")]
build:
    npm run build

[doc("Run typecheck, lint, and tests")]
[group("check")]
check: typecheck lint test

[doc("Run TypeScript without emitting files")]
[group("check")]
typecheck:
    npm run check

[doc("Run oxlint")]
[group("check")]
lint:
    npm run lint

[doc("Run the test suite")]
[group("check")]
test:
    npm test

[doc("Format source files with oxfmt")]
[group("format")]
fmt:
    npm run fmt

[doc("Check source formatting with oxfmt")]
[group("format")]
fmt-check:
    npm run fmt:check

[doc("Run the ACP smoke test")]
[group("smoke")]
smoke:
    npm run smoke
