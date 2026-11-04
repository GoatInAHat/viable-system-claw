# Milestone: runtime wiring and canary registration

Status: **build target, not active by default.** No production cutover. The service exists in `src/vsm/service.ts` and is proven by synthetic tests only.

## Goal

Register the durable VSM service inside the existing OpenClaw feature plugin so a Gateway can run it, while leaving the default behavior unchanged. Then prove the disabled path and the enabled startup path in tests.

## Scope

1. `openclaw.plugin.json` config schema gains:
   ```json
   { "runtime": { "type": "object", "additionalProperties": false, "properties": {
       "enabled": { "type": "boolean", "default": false },
       "principalId": { "type": "string" },
       "charter": { "type": "string" }
   } } }
   ```
2. `src/runtime.ts` (new): reads `api.pluginConfig`, validates it, and returns `undefined` unless `runtime.enabled === true`. When enabled it requires a non-empty `principalId` and `charter`; otherwise it throws a clear configuration error at startup, never silently.
3. Registration in `src/index.ts`:
   - Keep the existing backend service unchanged.
   - When runtime is enabled, open a second retained store namespace `vsm`, bootstrap the root document if absent (root id `root`), construct the service with the native adapter, register it as a separate service, and start a 30s canary interval that only applies observations.
   - On `stop()`, clear the interval and stop the service.
   - The disabled path adds no timers, no store, and no behavior change.
4. Tests in `src/runtime.test.ts`:
   - disabled config returns undefined and registers no service;
   - enabled config without principal/charter throws;
   - enabled config builds a service factory with the expected store namespace and root id;
   - a restart of the factory reads existing state instead of rebooting it.
   Use fake API objects; do not start a real Gateway.

## Acceptance

- `npx tsc -p hosts/openclaw/tsconfig.check.json --noEmit` passes.
- `node_modules/.bin/vitest run --config hosts/openclaw/vitest.config.ts --maxWorkers 1` passes.
- `git diff --stat` touches only `openclaw.plugin.json`, `src/index.ts`, `src/runtime.ts`, `src/runtime.test.ts`.
- Default behavior with no config remains identical to today.
