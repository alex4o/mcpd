import { describe, expect, test } from "bun:test";
import {
  defineMiddleware,
  applyMiddleware,
  stripJsonKeys,
  stripResultWrapper,
  resolveMiddleware,
} from "../middleware.ts";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

describe("stripJsonKeys", () => {
  test('removes quotes from JSON keys: "name": → name:', () => {
    const result = textResult('{"name": "value", "count": 42}');
    const processed = stripJsonKeys.response!("test", result);
    expect(processed.content[0]).toHaveProperty(
      "text",
      '{name: "value", count: 42}'
    );
  });

  test("handles nested objects", () => {
    const result = textResult('{"outer": {"inner": "val"}}');
    const processed = stripJsonKeys.response!("test", result);
    expect(processed.content[0]).toHaveProperty(
      "text",
      '{outer: {inner: "val"}}'
    );
  });

  test("passes through non-text content unchanged", () => {
    const result = {
      content: [{ type: "image" as const, data: "abc", mimeType: "image/png" }],
    };
    const processed = stripJsonKeys.response!("test", result);
    expect(processed).toEqual(result);
  });
});

describe("stripResultWrapper", () => {
  test('unwraps {"result": "data"} to "data"', () => {
    const result = textResult('{"result": "data"}');
    const processed = stripResultWrapper.response!("test", result);
    expect(processed.content[0]).toHaveProperty("text", "data");
  });

  test("unwraps object result to JSON", () => {
    const result = textResult('{"result": {"key": "val"}}');
    const processed = stripResultWrapper.response!("test", result);
    expect(processed.content[0]).toHaveProperty(
      "text",
      '{"key":"val"}'
    );
  });

  test("passes through non-wrapped content unchanged", () => {
    const result = textResult('{"name": "foo", "age": 30}');
    const processed = stripResultWrapper.response!("test", result);
    expect(processed.content[0]).toHaveProperty(
      "text",
      '{"name": "foo", "age": 30}'
    );
  });

  test("passes through non-JSON text", () => {
    const result = textResult("just plain text");
    const processed = stripResultWrapper.response!("test", result);
    expect(processed.content[0]).toHaveProperty("text", "just plain text");
  });
});

describe("defineMiddleware", () => {
  test("returns a valid middleware object", () => {
    const mw = defineMiddleware({
      name: "test-mw",
      response: (_name, result) => result,
    });
    expect(mw.name).toBe("test-mw");
    expect(typeof mw.response).toBe("function");
  });
});

describe("applyMiddleware", () => {
  test("runs pipeline in order", () => {
    const log: string[] = [];
    const mw1 = defineMiddleware({
      name: "first",
      response: (_name, result) => {
        log.push("first");
        return result;
      },
    });
    const mw2 = defineMiddleware({
      name: "second",
      response: (_name, result) => {
        log.push("second");
        return result;
      },
    });
    applyMiddleware([mw1, mw2], "tool", textResult("x"));
    expect(log).toEqual(["first", "second"]);
  });

  test("transforms are cumulative", () => {
    // First strip keys, then unwrap result
    const input = textResult('{"result": {"name": "test"}}');
    const result = applyMiddleware(
      [stripResultWrapper, stripJsonKeys],
      "tool",
      input
    );
    // stripResultWrapper unwraps to {"name":"test"}, then stripJsonKeys strips quotes
    expect(result.content[0]).toHaveProperty("text", '{name:"test"}');
  });
});

describe("resolveMiddleware", () => {
  test("resolves built-in middleware by name", () => {
    const mws = resolveMiddleware(["strip-json-keys", "strip-result-wrapper"]);
    expect(mws).toHaveLength(2);
    expect(mws[0]!.name).toBe("strip-json-keys");
    expect(mws[1]!.name).toBe("strip-result-wrapper");
  });

  test("throws on unknown middleware", () => {
    expect(() => resolveMiddleware(["nonexistent"])).toThrow("Unknown middleware");
  });
});
