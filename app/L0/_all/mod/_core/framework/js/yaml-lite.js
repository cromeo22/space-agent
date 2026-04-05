function stripInlineComment(rawLine) {
  let quote = "";

  for (let index = 0; index < rawLine.length; index += 1) {
    const char = rawLine[index];

    if (quote) {
      if (char === quote && rawLine[index - 1] !== "\\") {
        quote = "";
      }

      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "#") {
      return rawLine.slice(0, index);
    }
  }

  return rawLine;
}

function splitInlineList(sourceText) {
  const parts = [];
  let current = "";
  let quote = "";

  for (let index = 0; index < sourceText.length; index += 1) {
    const char = sourceText[index];

    if (quote) {
      current += char;

      if (char === quote && sourceText[index - 1] !== "\\") {
        quote = "";
      }

      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ",") {
      parts.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  parts.push(current);
  return parts;
}

function createBlockState(options = {}) {
  return {
    containerKey: options.containerKey || null,
    indent: Number.isFinite(options.indent) ? options.indent : 0,
    key: options.key || "",
    lines: []
  };
}

function assignNestedValue(target, containerKey, key, value) {
  if (!containerKey) {
    target[key] = value;
    return;
  }

  if (!target[containerKey] || typeof target[containerKey] !== "object" || Array.isArray(target[containerKey])) {
    target[containerKey] = {};
  }

  target[containerKey][key] = value;
}

export function parseYamlScalar(value) {
  const trimmed = String(value || "").trim();

  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();

    if (!inner) {
      return [];
    }

    return splitInlineList(inner)
      .map((part) => parseYamlScalar(part))
      .filter((part) => part !== "");
  }

  return trimmed;
}

export function parseSimpleYaml(sourceText) {
  const result = {};
  let currentKey = null;
  let blockState = null;

  const finalizeBlock = () => {
    if (!blockState) {
      return;
    }

    assignNestedValue(result, blockState.containerKey, blockState.key, blockState.lines.join("\n"));
    blockState = null;
  };

  String(sourceText || "")
    .split(/\r?\n/u)
    .forEach((rawLine) => {
      const rawIndent = rawLine.match(/^\s*/u)?.[0].length || 0;

      if (blockState) {
        if (!rawLine.trim()) {
          blockState.lines.push("");
          return;
        }

        if (rawIndent >= blockState.indent) {
          blockState.lines.push(rawLine.slice(blockState.indent));
          return;
        }

        finalizeBlock();
      }

      const withoutComment = stripInlineComment(rawLine);
      const trimmedLine = withoutComment.trimEnd();
      const indent = withoutComment.match(/^\s*/u)?.[0].length || 0;

      if (!trimmedLine.trim()) {
        return;
      }

      const topLevelKeyMatch =
        indent === 0 ? trimmedLine.match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/u) : null;

      if (topLevelKeyMatch) {
        const [, key, value] = topLevelKeyMatch;
        currentKey = null;

        if (value === undefined || value === "") {
          result[key] = null;
          currentKey = key;
          return;
        }

        if (value === "|") {
          result[key] = "";
          currentKey = key;
          blockState = createBlockState({
            indent: indent + 2,
            key
          });
          return;
        }

        result[key] = parseYamlScalar(value);
        return;
      }

      if (!currentKey || indent === 0) {
        return;
      }

      const nestedLine = trimmedLine.trimStart();
      const nestedKeyMatch = nestedLine.match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/u);

      if (nestedKeyMatch) {
        const [, key, value] = nestedKeyMatch;

        if (!result[currentKey] || typeof result[currentKey] !== "object" || Array.isArray(result[currentKey])) {
          result[currentKey] = {};
        }

        if (value === "|") {
          result[currentKey][key] = "";
          blockState = createBlockState({
            containerKey: currentKey,
            indent: indent + 2,
            key
          });
          return;
        }

        result[currentKey][key] = value === undefined || value === "" ? [] : parseYamlScalar(value);
        return;
      }

      const listMatch = nestedLine.match(/^-\s+(.*)$/u);
      if (listMatch) {
        if (!Array.isArray(result[currentKey])) {
          result[currentKey] = [];
        }

        const parsedValue = parseYamlScalar(listMatch[1]);

        if (Array.isArray(parsedValue)) {
          result[currentKey].push(...parsedValue);
          return;
        }

        result[currentKey].push(parsedValue);
      }
    });

  finalizeBlock();

  return result;
}

function formatYamlScalar(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);

  if (!text) {
    return '""';
  }

  if (text.includes("\n")) {
    return null;
  }

  if (/^[A-Za-z0-9._/@:+-]+$/u.test(text)) {
    return text;
  }

  return JSON.stringify(text);
}

export function serializeSimpleYaml(source) {
  const lines = [];

  function writeValue(key, rawValue, indent = 0) {
    const prefix = " ".repeat(indent);

    if (!key) {
      return;
    }

    if (Array.isArray(rawValue)) {
      if (rawValue.length === 0) {
        lines.push(`${prefix}${key}: []`);
        return;
      }

      lines.push(`${prefix}${key}:`);
      rawValue.forEach((item) => {
        lines.push(`${prefix}  - ${formatYamlScalar(item)}`);
      });
      return;
    }

    if (typeof rawValue === "string" && rawValue.includes("\n")) {
      lines.push(`${prefix}${key}: |`);
      rawValue.split("\n").forEach((line) => {
        lines.push(`${prefix}  ${line}`);
      });
      return;
    }

    if (rawValue && typeof rawValue === "object") {
      const entries = Object.entries(rawValue);

      if (entries.length === 0) {
        lines.push(`${prefix}${key}: {}`);
        return;
      }

      lines.push(`${prefix}${key}:`);
      entries.forEach(([nestedKey, nestedValue]) => {
        writeValue(nestedKey, nestedValue, indent + 2);
      });
      return;
    }

    lines.push(`${prefix}${key}: ${formatYamlScalar(rawValue)}`);
  }

  Object.entries(source || {}).forEach(([key, rawValue]) => {
    writeValue(key, rawValue, 0);
  });

  return `${lines.join("\n")}\n`;
}
