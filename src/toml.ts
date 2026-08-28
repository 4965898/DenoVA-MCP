// Minimal TOML reader tailored to Denova's config.toml files.
// Supports: comments (#), `key = value` scalars (string/number/bool),
// inline arrays, [table] / [table.sub] sections, [[array-of-tables]].
// Values are returned as JS primitives. Redaction of secrets is done at the
// text level to preserve exact formatting when re-reading.

export type TomlValue =
  | string
  | number
  | boolean
  | TomlValue[]
  | TomlSection
  | TomlSection[];

export interface TomlSection {
  [key: string]: TomlValue;
}

const ARRAY_OF_TABLES_KEY = "__tables";

function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'")) {
    let body = s.slice(1, -1);
    if (s[0] === '"') body = body.replace(/\\"/g, '"').replace(/\\n/g, "\n");
    return body;
  }
  return s;
}

function parseValue(raw: string): TomlValue {
  const s = raw.trim();
  if (s === "") return "";
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return inner
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "")
      .map(unquote);
  }
  if (s[0] === '"' || s[0] === "'") return unquote(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function ensureTable(parent: TomlSection, key: string): TomlSection {
  // key may be dotted: "agent_models.ide"
  const parts = key.split(".");
  let cur = parent;
  for (const p of parts) {
    const existing = cur[p];
    if (existing && typeof existing === "object" && !Array.isArray(existing) && !(existing instanceof Array)) {
      cur = existing as TomlSection;
    } else {
      const next: TomlSection = {};
      cur[p] = next;
      cur = next;
    }
  }
  return cur;
}

const TOML_REDACT_KEYS = new Set([
  "openai_api_key",
  "api_key",
  "apikey",
  "access_token",
  "token",
  "secret",
  "password",
]);

/** Detect secrets in a `key = value` assignment and return a masked value. */
export function maybeRedact(key: string, value: string): string | null {
  const k = key.trim().toLowerCase();
  const base = k.includes(".") ? k.split(".").pop()!.trim() : k;
  if (TOML_REDACT_KEYS.has(base)) {
    return value.trim().length > 0 ? "<redacted:API_KEY_HIDDEN>" : value;
  }
  return null;
}

/**
 * Return config.toml text with secret values masked (so external agents never
 * see Denova API keys).
 */
export function redactTomlText(raw: string): string {
  return raw
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("=");
      if (idx === -1) return line;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      const redacted = maybeRedact(key, value);
      if (redacted !== null) return `${line.slice(0, idx + 1)} ${redacted}`;
      return line;
    })
    .join("\n");
}

/**
 * Parse a TOML document into a nested object. Array-of-tables entries are
 * grouped under the key (as an array of sections). Keys that repeat as
 * headers are flattened per basic-Toml semantics.
 */
export function parseToml(raw: string): TomlSection {
  const root: TomlSection = {};
  let current: TomlSection = root;
  let currentArrayKey: string | null = null;

  for (let rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    if (line.startsWith("[[") && line.endsWith("]]")) {
      const key = line.slice(2, -2).trim();
      const arr = root[key] as TomlSection[] | undefined;
      if (!Array.isArray(arr)) {
        root[key] = [];
      }
      const list = root[key] as TomlSection[];
      const entry: TomlSection = {};
      list.push(entry);
      current = entry;
      currentArrayKey = key;
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      const key = line.slice(1, -1).trim();
      current = ensureTable(root, key);
      currentArrayKey = null;
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = parseValue(line.slice(eq + 1));
    current[key] = value;
  }

  void currentArrayKey;
  return root;
}
