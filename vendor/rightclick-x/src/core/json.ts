// JSON.parse accepts numbers it cannot represent and silently collapses duplicate object keys.
// Keep those cases out of typed execution; callers can retain the original document as text.
export class JsonRepresentationError extends Error {}

function decimal(token: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)!;
  let digits = (match[2] + (match[3] ?? "")).replace(/^0+/, "");
  if (!digits) return match[1] + "0";
  const trailing = /0*$/.exec(digits)![0].length;
  digits = digits.slice(0, digits.length - trailing);
  return `${match[1]}${digits}e${BigInt(match[4] ?? "0") - BigInt((match[3] ?? "").length) + BigInt(trailing)}`;
}

/** Native JSON parsing, with an additional check that values survive JSON serialization. */
export function parseJsonValue(text: string): unknown {
  const value: unknown = JSON.parse(text); // Syntax belongs to the native parser.
  const stack: Array<{ keys: Set<string>; expectingKey: boolean } | null> = [];
  const tokens = /"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,]|true|false|null/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === "{") stack.push({ keys: new Set(), expectingKey: true });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token === ",") { const object = stack.at(-1); if (object) object.expectingKey = true; }
    else if (token.startsWith('"')) {
      const object = stack.at(-1);
      if (object?.expectingKey) {
        const key: string = JSON.parse(token);
        if (object.keys.has(key)) throw new JsonRepresentationError("duplicate object key cannot be represented without discarding data");
        object.keys.add(key); object.expectingKey = false;
      }
    } else if (/^-?\d/.test(token)) {
      const number = Number(token);
      if (!Number.isFinite(number) || number === 0 && /[1-9]/.test(token.split(/[eE]/, 1)[0]) || decimal(token) !== decimal(JSON.stringify(number))) throw new JsonRepresentationError("JSON number cannot be represented without changing its value");
    }
  }
  return value;
}
