# Viable System Claw

A native OpenClaw plugin for persistent responsibilities, recursive organization, and adaptive compute allocation.

The primary interface is an interactive graph of nested systems. Nodes and relationships expose observed execution, tool calls, and communication. A separate compute page shows capacity, quotas, and allocation evidence.

## Status

Early implementation. Not yet installed or qualified for autonomous operation. No existing operational owners are replaced.

## Design

- Persistent purposes outlive individual sessions and workflows.
- Reuse OpenClaw public APIs for execution, state, events, navigation, and UI.
- Model capabilities and quota consumption are measured data, not hardcoded model rankings.
- Animation represents observed activity; missing telemetry remains unknown.
- Keep interfaces focused: no decorative metrics, fake activity, or placeholder control panels.

Implementation lives in `hosts/openclaw`.
