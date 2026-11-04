# Verification scope

## First implementation

- TypeScript checks cover production source and test fixtures.
- 74 behavior tests pass across six suites: native feature registration, retained backend state, compute planning/accounting, graph state, DOM interactions and native UI contributions.
- Backend and browser bundles build with the pinned OpenClaw CLI; native plugin validation passes.
- Headless Chromium replay checked six nested nodes, correlated tool activity, selection/inspector interaction, desktop and 390-pixel mobile layout, and both pages. No browser page errors or mobile horizontal overflow were observed. The documentation screenshot is explicitly synthetic.
- An independent implementation review reproduced access, session-incarnation, restart/rebind activity, reset-accounting and native transport-boundary defects. Regression tests cover the corrected behaviors. The independent final recheck reproduced the original transport and rebinding cases against the fixes and found no remaining high-confidence blocker within this scope.

Native registration tests use the **real installed feature wrapper and validation**, with synthetic host/store/event fixtures. UI tests use real DOM rendering with a fake host. These tests are not a live Gateway installation proof.

## Not yet proven

- Actual installation/activation and event delivery in a disposable Gateway, including permission filtering and reconnect behavior across process failures.
- Real retained-store crash recovery, external provider quota/usage observation, live shared-compute contention and calibration.
- Durable reservation/execution reconciliation, autonomous regulation, verified adoption or migration of operational responsibilities.

GitHub Actions runs locked dependency installation, type checking, tests, native build and package validation. Its run log is the portable-build record; local verification alone does not substitute for CI.
