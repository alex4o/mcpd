import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface McpMiddleware {
  name: string;
  response?: (toolName: string, result: CallToolResult) => CallToolResult;
}

export function defineMiddleware(middleware: McpMiddleware): McpMiddleware {
  return middleware;
}

export const stripJsonKeys = defineMiddleware({
  name: "strip-json-keys",
  response(_toolName, result) {
    if (!("content" in result)) return result;
    return {
      ...result,
      content: result.content.map((block) => {
        if (block.type !== "text") return block;
        // Replace "key": with key: but avoid mangling strings that contain ":
        // We match "word": at the start of a value context
        return {
          ...block,
          text: block.text.replace(/"(\w+)"\s*:/g, "$1:"),
        };
      }),
    };
  },
});

export const stripResultWrapper = defineMiddleware({
  name: "strip-result-wrapper",
  response(_toolName, result) {
    if (!("content" in result)) return result;
    return {
      ...result,
      content: result.content.map((block) => {
        if (block.type !== "text") return block;
        try {
          const parsed = JSON.parse(block.text);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            Object.keys(parsed).length === 1 &&
            "result" in parsed
          ) {
            const unwrapped = parsed.result;
            return {
              ...block,
              text:
                typeof unwrapped === "string"
                  ? unwrapped
                  : JSON.stringify(unwrapped),
            };
          }
        } catch {
          // not JSON, pass through
        }
        return block;
      }),
    };
  },
});

const BUILTIN_MIDDLEWARES: Record<string, McpMiddleware> = {
  "strip-json-keys": stripJsonKeys,
  "strip-result-wrapper": stripResultWrapper,
};

export function resolveMiddleware(
  specs: (string | Record<string, any>)[]
): McpMiddleware[] {
  return specs.map((spec) => {
    if (typeof spec === "string") {
      const mw = BUILTIN_MIDDLEWARES[spec];
      if (!mw) throw new Error(`Unknown middleware: ${spec}`);
      return mw;
    }
    // Record form: { name: config } — for future use with configurable middlewares
    const name = Object.keys(spec)[0]!;
    const mw = BUILTIN_MIDDLEWARES[name];
    if (!mw) throw new Error(`Unknown middleware: ${name}`);
    return mw;
  });
}

export function applyMiddleware(
  middlewares: McpMiddleware[],
  toolName: string,
  result: CallToolResult
): CallToolResult {
  let current = result;
  for (const mw of middlewares) {
    if (mw.response) {
      current = mw.response(toolName, current);
    }
  }
  return current;
}
