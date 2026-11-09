// 先驗 JSON 語法，再以詞法掃描保留 key 的出現次數（JSON.parse 會覆蓋重複鍵）。
export function parseStudentJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
  const objects: (Set<string> | null)[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "{") objects.push(new Set());
    else if (token === "[") objects.push(null);
    else if (token === "}" || token === "]") objects.pop();
    else if (token.startsWith('"') && tokens[index + 1] === ":") {
      const object = objects.at(-1);
      if (!object) throw new Error("JSON key 結構不正確。");
      const key: unknown = JSON.parse(token);
      if (typeof key !== "string" || object.has(key)) throw new Error("JSON 不接受重複鍵。");
      object.add(key);
    }
  }
  return parsed;
}
