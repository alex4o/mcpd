import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import JSON5 from "json5";
import { encode as toonEncode } from "@toon-format/toon";

export interface McpMiddleware {
  name: string;
  response?: (toolName: string, result: CallToolResult) => CallToolResult;
}

export function defineMiddleware(middleware: McpMiddleware): McpMiddleware {
  return middleware;
}

/** Map over text blocks in a result, leaving non-text blocks unchanged. */
function mapTextBlocks(
  result: CallToolResult,
  fn: (text: string) => string | null,
): CallToolResult {
  if (!("content" in result)) return result;
  return {
    ...result,
    content: result.content.map((block) => {
      if (block.type !== "text") return block;
      const mapped = fn(block.text);
      return mapped === null ? block : { ...block, text: mapped };
    }),
  };
}

/** Try to parse JSON text, apply a transform, return null to pass through. */
function tryJsonTransform(
  text: string,
  fn: (parsed: unknown) => string | null,
): string | null {
  try {
    return fn(JSON.parse(text));
  } catch {
    return null;
  }
}

export const stripJsonKeys = defineMiddleware({
  name: "strip-json-keys",
  response(_toolName, result) {
    return mapTextBlocks(result, (text) =>
      text.replace(/"(\w+)"\s*:/g, "$1:"),
    );
  },
});

export const stripResultWrapper = defineMiddleware({
  name: "strip-result-wrapper",
  response(_toolName, result) {
    return mapTextBlocks(result, (text) =>
      tryJsonTransform(text, (parsed) => {
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Object.keys(parsed).length !== 1 ||
          !("result" in parsed)
        ) return null;
        const unwrapped = (parsed as any).result;
        return typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped);
      }),
    );
  },
});

export const extractJsonResults = defineMiddleware({
  name: "extract-json-results",
  response(_toolName, result) {
    return mapTextBlocks(result, (text) =>
      tryJsonTransform(text, (parsed) => {
        if (typeof parsed !== "object" || parsed === null || !("results" in parsed)) return null;
        const value = (parsed as any).results;
        return typeof value === "string" ? value : JSON.stringify(value);
      }),
    );
  },
});

export const json5Format = defineMiddleware({
  name: "json5",
  response(_toolName, result) {
    return mapTextBlocks(result, (text) =>
      tryJsonTransform(text, (parsed) => JSON5.stringify(parsed)),
    );
  },
});

export const toon = defineMiddleware({
  name: "toon",
  response(_toolName, result) {
    return mapTextBlocks(result, (text) =>
      tryJsonTransform(text, (parsed) => {
        if (typeof parsed !== "object" || parsed === null) return null;
        return toonEncode(parsed);
      }),
    );
  },
});

const BUILTIN_MIDDLEWARES: Record<string, McpMiddleware> = {
  "strip-json-keys": stripJsonKeys,
  "strip-result-wrapper": stripResultWrapper,
  "extract-json-results": extractJsonResults,
  "json5": json5Format,
  "toon": toon,
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
