import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactTomlText } from "./toml.js";

const execFileAsync = promisify(execFile);

export interface Book {
  name: string;
  path: string;
  author?: string;
  last_opened_at?: string;
}

export interface ChapterRef {
  order: number;
  title: string;
  filename: string;
  relPath: string;
  bytes: number;
}

export interface LoreItem {
  id: string;
  enabled?: boolean;
  type?: string;
  name?: string;
  importance?: string;
  tags?: string[];
  brief_description?: string;
  keywords?: string[];
  load_mode?: string;
  content?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface Entry {
  path: string; // relative to project
  type: "file" | "dir";
}

export function humanizeBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Resolve the Denova home data directory (folder containing books.json). */
export function resolveHomeDir(): string {
  const env = process.env.DENOVA_DIR;
  if (env && env.trim()) return path.resolve(env.trim());

  // Optional config file in the current working directory.
  const cfgPath = path.resolve(process.cwd(), ".denova-mcp.json");
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      if (cfg.denovaDir) return path.resolve(cfg.denovaDir);
    } catch {
      /* ignore malformed config */
    }
  }
  throw new Error(
    "无法定位 Denova 数据目录。请设置环境变量 DENOVA_DIR（例如 DENOVA_DIR=/path/to/denova/.denova），或在当前目录创建 .denova-mcp.json 并写入 { \"denovaDir\": \"...\" }。"
  );
}

function readJson<T>(file: string): T {
  const raw = fs.readFileSync(file, "utf-8");
  return JSON.parse(raw) as T;
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** List books/projects registered in books.json. */
export function listBooks(homeDir: string): Book[] {
  const booksPath = path.join(homeDir, "books.json");
  if (!fs.existsSync(booksPath)) return [];
  const doc = readJson<{ books?: Book[]; current?: string }>(booksPath);
  return (doc.books ?? []).map((b) => ({
    ...b,
    path: b.path ? path.resolve(b.path) : path.join(homeDir, "projects", b.name),
  }));
}

export function currentBook(homeDir: string): string | undefined {
  const booksPath = path.join(homeDir, "books.json");
  if (!fs.existsSync(booksPath)) return undefined;
  const doc = readJson<{ current?: string }>(booksPath);
  return doc.current;
}

/** Resolve a project directory by name. Falls back to `current` book. */
export function resolveProjectDir(homeDir: string, name?: string): string {
  const books = listBooks(homeDir);
  if (name) {
    const hit = books.find((b) => b.name === name || b.path.endsWith(name));
    if (hit) return hit.path;
    const byDir = path.join(homeDir, "projects", name);
    if (fs.existsSync(byDir)) return byDir;
    throw new Error(`找不到项目「${name}」。可用: ${listBooks(homeDir).map((b) => b.name).join("、") || "（无）"}`);
  }
  const cur = currentBook(homeDir);
  if (cur) {
    const hit = books.find((b) => b.name === cur);
    if (hit) return hit.path;
  }
  if (books.length > 0) return books[0].path;
  throw new Error("Denova 中没有任何项目(book)。请先在 Denova 中创建作品，或指定 project 参数。");
}

export function listProjectFiles(projectDir: string, maxDepth = 6): Entry[] {
  const entries: Entry[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > maxDepth) return;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    names.sort((a, b) => a.localeCompare(b, "zh"));
    for (const n of names) {
      if (n === ".git" || n === "node_modules") continue;
      const full = path.join(dir, n);
      const relPath = rel ? `${rel}/${n}` : n;
      let isDir = false;
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        entries.push({ path: relPath, type: "dir" });
        walk(full, relPath, depth + 1);
      } else {
        entries.push({ path: relPath, type: "file" });
      }
    }
  };
  walk(projectDir, "", 0);
  return entries;
}

function readProjectFile(projectDir: string, relPath: string): string | null {
  const full = path.join(projectDir, relPath);
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return null;
  return fs.readFileSync(full, "utf-8");
}

/** Guess the default outline file for a project. */
function outlineCandidates(projectDir: string): string[] {
  const c = [
    "setting/outline.md",
    "設定/outline.md",
    "大纲.md",
    "大纲 2.md",
    "設定.md",
  ];
  return c;
}

export function readFileWithList(projectDir: string, relPath: string): {
  exists: boolean;
  content: string | null;
  fullPath: string;
} {
  const full = path.join(projectDir, relPath);
  const exists = fs.existsSync(full) && !fs.statSync(full).isDirectory();
  const content = exists ? fs.readFileSync(full, "utf-8") : null;
  return { exists, content, fullPath: full };
}

/* ------------------------------- chapters ------------------------------- */

const CHAPTER_RE = /ch(\d{5})-(.+)\.md$/;

export function listChapters(projectDir: string): ChapterRef[] {
  const chaptersRoot = path.join(projectDir, "chapters");
  if (!fs.existsSync(chaptersRoot)) return [];
  const out: ChapterRef[] = [];
  const walk = (dir: string, rel: string) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    names.sort((a, b) => a.localeCompare(b, "zh"));
    for (const n of names) {
      const full = path.join(dir, n);
      const relPath = rel ? `${rel}/${n}` : n;
      let isDir = false;
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(full, relPath);
      } else if (n.endsWith(".md")) {
        const m = n.match(CHAPTER_RE);
        if (m) {
          out.push({
            order: parseInt(m[1], 10),
            title: m[2],
            filename: n,
            relPath: path.posix.join("chapters", relPath),
            bytes: fs.statSync(full).size,
          });
        }
      }
    }
  };
  walk(chaptersRoot, "");
  out.sort((a, b) => a.order - b.order);
  return out;
}

export interface ChapterWriteOptions {
  title: string;
  body: string;
  order?: number;
  volumeDir?: string | null; // null -> auto
  groupSize?: number;
}

/** Build the target relative chapter path honoring Denova layout. */
export function buildChapterRelPath(projectDir: string, opts: ChapterWriteOptions): string {
  const existing = listChapters(projectDir);
  const order =
    opts.order ?? (existing.length > 0 ? existing[existing.length - 1].order + 1 : 1);

  const safeTitle = path.basename(
    opts.title
      .replace(/[\\\/:*?"<>|\n\r]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "无题"
  );
  const filename = `ch${String(order).padStart(5, "0")}-${safeTitle}.md`;

  // Volume mode if any existing chapter lives in a chapters/<volume>/ subdir.
  const hasVolumes = existing.some((c) => c.relPath.split("/").length > 2);
  const volumeMode =
    opts.volumeDir !== null && (hasVolumes || opts.volumeDir !== undefined);

  if (!volumeMode) {
    return path.posix.join("chapters", filename);
  }

  if (opts.volumeDir) {
    return path.posix.join("chapters", opts.volumeDir, filename);
  }

  const groupSize = opts.groupSize ?? 8;
  const vol = Math.floor((order - 1) / groupSize) + 1;
  const volumeDir = `v${String(vol).padStart(5, "0")}-第${vol}卷`;
  return path.posix.join("chapters", volumeDir, filename);
}

export function writeChapter(projectDir: string, relPath: string, body: string): void {
  const full = path.join(projectDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, "utf-8");
}

export function readChapter(projectDir: string, orderOrPath: string | number): {
  relPath: string;
  content: string;
} | null {
  const chapters = listChapters(projectDir);
  let ch: ChapterRef | undefined;
  if (typeof orderOrPath === "number") {
    ch = chapters.find((c) => c.order === orderOrPath);
  } else {
    const s = String(orderOrPath).trim();
    // 兼容带/不带 chapters/ 前缀的路径：
    //   "chapters/ch00001-x.md" | "ch00001-x.md"
    //   "chapters/v00001-卷/ch00001-x.md" | "v00001-卷/ch00001-x.md"
    ch = chapters.find((c) => c.relPath === s);
    if (!ch) ch = chapters.find((c) => c.relPath.endsWith("/" + s) || c.filename === s || c.title === s);
    if (!ch && /^\d+$/.test(s)) ch = chapters.find((c) => c.order === parseInt(s, 10));
  }
  if (!ch) return null;
  const full = path.join(projectDir, ch.relPath);
  return { relPath: ch.relPath, content: fs.readFileSync(full, "utf-8") };
}

/* ------------------------------ lore / 资料库 ---------------------------- */

function loreFile(projectDir: string): string {
  return path.join(projectDir, ".denova", "lore", "items.json");
}

export function listLoreItems(projectDir: string): LoreItem[] {
  const file = loreFile(projectDir);
  if (!fs.existsSync(file)) return [];
  const doc = readJson<{ version?: number; items: LoreItem[] }>(file);
  return doc.items ?? [];
}

export function readLoreItems(projectDir: string, ids?: string[]): LoreItem[] {
  const all = listLoreItems(projectDir);
  if (ids && ids.length > 0) {
    const set = new Set(ids);
    return all.filter((it) => set.has(it.id));
  }
  return all.filter((it) => it.enabled !== false);
}

export function upsertLoreItems(projectDir: string, items: LoreItem[]): { added: string[]; updated: string[] } {
  const file = loreFile(projectDir);
  let doc: { version?: number; items: LoreItem[] };
  if (fs.existsSync(file)) {
    doc = readJson<{ version?: number; items: LoreItem[] }>(file);
  } else {
    doc = { version: 2, items: [] };
  }
  if (!Array.isArray(doc.items)) doc.items = [];
  const now = new Date().toISOString();
  const added: string[] = [];
  const updated: string[] = [];
  const byId = new Map(doc.items.map((it) => [it.id, it]));
  for (const incoming of items) {
    if (!incoming || typeof incoming.id !== "string" || incoming.id === "") {
      throw new Error("每条资料库条目必须包含非空 id 字段。");
    }
    const existing = byId.get(incoming.id);
    if (existing) {
      byId.set(incoming.id, { ...existing, ...incoming, updated_at: now });
      updated.push(incoming.id);
    } else {
      byId.set(incoming.id, {
        enabled: true,
        type: "other",
        type_source: "manual",
        importance: "minor",
        tags: [],
        load_mode: "manual",
        ...incoming,
        created_at: now,
        updated_at: now,
      });
      added.push(incoming.id);
    }
  }
  writeJson(file, { version: 2, items: Array.from(byId.values()) });
  return { added, updated };
}

/* ----------------------------- config / TOML ---------------------------- */

export function readConfigRedacted(projectDir: string | null): { text: string; scope: string } {
  const targets: { full: string; scope: string }[] = [];
  if (projectDir) {
    targets.push({ full: path.join(projectDir, ".denova", "config.toml"), scope: "workspace" });
  }
  const home = resolveHomeDir();
  targets.push({ full: path.join(home, "config.toml"), scope: "user" });

  const found = targets.find((t) => fs.existsSync(t.full));
  if (!found) return { text: "", scope: "none" };
  const raw = fs.readFileSync(found.full, "utf-8");
  return { text: redactTomlText(raw), scope: found.scope };
}

/* ------------------------------- versions -------------------------------- */

export async function listVersions(projectDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", projectDir, "log", "--oneline", "-n", "30"]);
    return stdout.trim();
  } catch (e) {
    return `无法读取版本历史（可能不是 git 仓库）：${(e as Error).message.split("\n")[0]}`;
  }
}

export async function createVersion(projectDir: string, message: string): Promise<string> {
  try {
    await execFileAsync("git", ["-C", projectDir, "add", "-A"]);
    const { stdout } = await execFileAsync("git", ["-C", projectDir, "commit", "-m", message]);
    return stdout.trim() || `已创建版本：${message}`;
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    if (/nothing to commit|no changes/.test(msg)) return "没有需要提交的改动。";
    return `版本创建失败：${msg}`;
  }
}

/* ------------------------------ automations ------------------------------ */

export function listAutomations(projectDir: string): unknown {
  const file = path.join(projectDir, ".denova", "automations", "tasks.json");
  if (!fs.existsSync(file)) return [];
  return readJson(file);
}

export function writeAutomations(projectDir: string, tasks: unknown): void {
  const file = path.join(projectDir, ".denova", "automations", "tasks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, tasks);
}

/* ------------------------------ skills ------------------------------------ */

export interface SkillMeta {
  dir: string;
  name: string;
  description: string;
  agent?: string;
}

export function listSkills(homeDir: string, projectDir?: string): SkillMeta[] {
  const roots: string[] = [];
  if (projectDir) roots.push(path.join(projectDir, ".denova", "skills"));
  roots.push(path.join(homeDir, "skills"));
  const out: SkillMeta[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let names: string[];
    try {
      names = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of names.sort((a, b) => a.localeCompare(b, "zh"))) {
      if (seen.has(name)) continue;
      seen.add(name);
      const skillFile = path.join(root, name, "SKILL.md");
      let description = "";
      let agent: string | undefined;
      if (fs.existsSync(skillFile)) {
        const raw = fs.readFileSync(skillFile, "utf-8");
        const d = raw.match(/description:\s*(.+)/);
        const a = raw.match(/agent:\s*(.+)/);
        if (d) description = d[1].trim().replace(/^["']|["']$/g, "");
        if (a) agent = a[1].trim();
      }
      out.push({ dir: name, name, description, agent });
    }
  }
  return out;
}

export function readSkill(homeDir: string, name: string, projectDir?: string): string | null {
  const roots: string[] = [];
  if (projectDir) roots.push(path.join(projectDir, ".denova", "skills", name, "SKILL.md"));
  roots.push(path.join(homeDir, "skills", name, "SKILL.md"));
  for (const full of roots) {
    if (fs.existsSync(full)) return fs.readFileSync(full, "utf-8");
  }
  return null;
}

/* --------------------------- project creation ----------------------------- */

export function createProject(homeDir: string, name: string): string {
  if (!name || !name.trim()) throw new Error("项目名不能为空。");
  const cleaner = name.replace(/[\\\/:*?"<>|\n\r]/g, "").trim();
  const dir = path.join(homeDir, "projects", cleaner);
  if (fs.existsSync(dir)) throw new Error(`项目目录已存在：${dir}`);
  fs.mkdirSync(path.join(dir, "chapters"), { recursive: true });
  fs.mkdirSync(path.join(dir, "setting"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".denova", "lore"), { recursive: true });
  if (!fs.existsSync(path.join(dir, "CREATOR.md"))) {
    fs.writeFileSync(path.join(dir, "CREATOR.md"), `# ${cleaner}\n\n（在此编写全书创作说明 / 世界观 / 写作约定。）\n`, "utf-8");
  }
  if (!fs.existsSync(path.join(dir, "ideas.md"))) {
    fs.writeFileSync(path.join(dir, "ideas.md"), "# 点子\n\n", "utf-8");
  }
  if (!fs.existsSync(path.join(dir, "setting", "progress.md"))) {
    fs.writeFileSync(path.join(dir, "setting", "progress.md"), "# 写作进度\n\n## 当前进度\n\n- 暂无\n\n", "utf-8");
  }
  if (!fs.existsSync(path.join(dir, ".denova", "lore", "items.json"))) {
    writeJson(path.join(dir, ".denova", "lore", "items.json"), { version: 2, items: [] });
  }

  const booksPath = path.join(homeDir, "books.json");
  const doc: { books?: Book[]; current?: string } = fs.existsSync(booksPath)
    ? readJson(booksPath)
    : {};
  const books = Array.isArray(doc.books) ? doc.books : [];
  if (!books.some((b) => b.name === cleaner)) {
    books.push({ name: cleaner, path: dir, last_opened_at: new Date().toISOString() });
  }
  writeJson(booksPath, { ...doc, books, current: cleaner, sort_mode: "recent" });
  return dir;
}

/* ------------------------------ file paths -------------------------------- */

export { outlineCandidates };
