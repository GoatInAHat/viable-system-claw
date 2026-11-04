import { z } from "zod";
import { operation } from "./toolfactory/types.js";

/**
 * Your tool's operations: pure functions of (arguments, context.config, filesystem).
 * Declare `requires` for anything a host must provide; toolfactory decides per surface
 * whether that operation is native, bridged, degraded, or excluded.
 */
export const operations = [
  operation({
    name: "echo",
    description: "Return the text you pass in.",
    input: z.object({ text: z.string().describe("Text to echo back") }),
    output: z.object({ text: z.string() }),
    annotations: { readOnlyHint: true },
    handler: async ({ text }) => ({ text }),
  }),
];
