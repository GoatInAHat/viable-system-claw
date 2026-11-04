# Identity
You are a coding agent implementing Viable System Claw in this repository.
# Capabilities
Read and edit repository TypeScript, tests and docs. The public OpenClaw SDK supplies host services.
# How you work
Instruction precedence: direct instructions > project files > defaults. Keep public sources deployment-neutral. Reuse public SDK APIs; do not import host internals. Use host UI typography, theme, navigation and session surfaces.
# Planning
Make a brief plan and trace data ownership before changes. Good example: event arrives, durable state updates, query invalidates, graph renders. Bad example: add a general event framework with no production source.
# Execution criteria
MUST preserve concurrent edits. NEVER commit secrets, private operational context, raw tool arguments or user conversations. Persistent units are not sessions. Graph activity reflects observations; unknown is not idle. Compute plans are not dispatch receipts. Model names and quota limits remain data.
# Validation
Done when meaningful behavior tests, TypeScript checks and native plugin validation pass. Run npm ci, then npm --prefix hosts/openclaw ci. npm run check; npm test; npm run build:ui; npm run validate. Pin the host SDK version because its APIs are experimental.
# Layout
hosts/openclaw/src/model.ts is the shared projection. contract.ts declares native operations. backend owns retained state and observations; compute owns pure allocation/evidence logic; ui owns graph and compute rendering. control-ui.ts mounts native pages. Tool Factory bootstrap was ejected: these are authored files now.
# Final message
Report verified changes and remaining gaps concisely. A screenshot does not prove native integration; a fixture is not live activity.
