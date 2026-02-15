import { describe, expect, test } from "bun:test";
import {
  defineMiddleware,
  applyMiddleware,
  stripJsonKeys,
  stripResultWrapper,
  extractJsonResults,
  json5Format,
  toon,
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
    const mws = resolveMiddleware(["strip-json-keys", "strip-result-wrapper", "extract-json-results", "json5", "toon"]);
    expect(mws).toHaveLength(5);
    expect(mws[0]!.name).toBe("strip-json-keys");
    expect(mws[1]!.name).toBe("strip-result-wrapper");
    expect(mws[2]!.name).toBe("extract-json-results");
    expect(mws[3]!.name).toBe("json5");
    expect(mws[4]!.name).toBe("toon");
  });

  test("throws on unknown middleware", () => {
    expect(() => resolveMiddleware(["nonexistent"])).toThrow("Unknown middleware");
  });
});

describe("json5Format", () => {
  test("unquotes identifier keys in compact format", () => {
    const result = textResult('{"name": "value", "count": 42}');
    const processed = json5Format.response!("test", result);
    expect(processed.content[0]).toHaveProperty("text", "{name:'value',count:42}");
  });

  test("keeps non-identifier keys quoted", () => {
    const result = textResult('{"special-key": "value", "123": "num"}');
    const processed = json5Format.response!("test", result);
    const text = (processed.content[0] as any).text;
    expect(text).toContain("'special-key':");
    expect(text).toContain("'123':");
  });

  test("handles nested objects", () => {
    const result = textResult('{"outer": {"inner": "val"}}');
    const processed = json5Format.response!("test", result);
    expect(processed.content[0]).toHaveProperty("text", "{outer:{inner:'val'}}");
  });

  test("handles arrays", () => {
    const result = textResult('[{"id": 1}, {"id": 2}]');
    const processed = json5Format.response!("test", result);
    const text = (processed.content[0] as any).text;
    expect(text).toBe("[{id:1},{id:2}]");
  });

  test("passes through non-JSON text unchanged", () => {
    const result = textResult("just plain text");
    const processed = json5Format.response!("test", result);
    expect(processed.content[0]).toHaveProperty("text", "just plain text");
  });

  test("passes through non-text content unchanged", () => {
    const result = {
      content: [{ type: "image" as const, data: "abc", mimeType: "image/png" }],
    };
    const processed = json5Format.response!("test", result);
    expect(processed).toEqual(result);
  });

  test("does not corrupt strings containing key-like patterns", () => {
    const result = textResult('{"desc": "set \\"mode\\": true"}');
    const processed = json5Format.response!("test", result);
    const text = (processed.content[0] as any).text;
    expect(text).toContain("desc:");
    expect(text).toContain('set "mode": true');
  });
});

describe("toon", () => {
  test("converts JSON object to TOON indentation format", () => {
    const result = textResult('{"name": "Alice", "age": 30}');
    const processed = toon.response!("test", result);
    const text = (processed.content[0] as any).text;
    expect(text).toContain("name: Alice");
    expect(text).toContain("age: 30");
  });

  test("converts JSON array to TOON tabular format", () => {
    const input = JSON.stringify([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    const result = textResult(input);
    const processed = toon.response!("test", result);
    const text = (processed.content[0] as any).text;
    expect(text).toContain("{id,name}");
    expect(text).toContain("1,Alice");
    expect(text).toContain("2,Bob");
  });

  test("handles nested objects", () => {
    const input = JSON.stringify({
      user: { name: "Alice", address: { city: "NYC" } },
    });
    const result = textResult(input);
    const processed = toon.response!("test", result);
    const text = (processed.content[0] as any).text;
    expect(text).toContain("Alice");
    expect(text).toContain("NYC");
  });

  test("passes through non-JSON text unchanged", () => {
    const result = textResult("just plain text");
    const processed = toon.response!("test", result);
    expect(processed.content[0]).toHaveProperty("text", "just plain text");
  });

  test("passes through primitive JSON values unchanged", () => {
    const result = textResult("42");
    const processed = toon.response!("test", result);
    expect(processed.content[0]).toHaveProperty("text", "42");
  });

  test("passes through JSON string values unchanged", () => {
    const result = textResult('"hello"');
    const processed = toon.response!("test", result);
    expect(processed.content[0]).toHaveProperty("text", '"hello"');
  });

  test("passes through non-text content unchanged", () => {
    const result = {
      content: [{ type: "image" as const, data: "abc", mimeType: "image/png" }],
    };
    const processed = toon.response!("test", result);
    expect(processed).toEqual(result);
  });

  test("extract-json-results then toon pipeline works", () => {
    const input = textResult(JSON.stringify({
      results: [{ id: 1, name: "a" }, { id: 2, name: "b" }]
    }));
    const result = applyMiddleware(
      [extractJsonResults, toon],
      "tool",
      input
    );
    const text = (result.content[0] as any).text;
    expect(text).toContain("{id,name}");
    expect(text).toContain("1,a");
    expect(text).toContain("2,b");
  });
});

describe("extractJsonResults", () => {
  test('unwraps {"results": [...]} to the array', () => {
    const result = textResult('{"results": [1, 2, 3]}');
    const processed = extractJsonResults.response!("test", result);
    expect(processed.content[0]).toHaveProperty("text", "[1,2,3]");
  });

  test('unwraps {"results": "data"} to the string', () => {
    const result = textResult('{"results": "data"}');
    const processed = extractJsonResults.response!("test", result);
    expect(processed.content[0]).toHaveProperty("text", "data");
  });

  test("passes through object without results key unchanged", () => {
    const result = textResult('{"name": "foo", "age": 30}');
    const processed = extractJsonResults.response!("test", result);
    expect(processed.content[0]).toHaveProperty(
      "text",
      '{"name": "foo", "age": 30}'
    );
  });

  test("passes through non-JSON text", () => {
    const result = textResult("just plain text");
    const processed = extractJsonResults.response!("test", result);
    expect(processed.content[0]).toHaveProperty("text", "just plain text");
  });

  test("passes through non-object JSON", () => {
    const result = textResult("42");
    const processed = extractJsonResults.response!("test", result);
    expect(processed.content[0]).toHaveProperty("text", "42");
  });
});
