import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveHomeDir,
  listBooks,
  currentBook,
  resolveProjectDir,
  listProjectFiles,
  readFileWithList,
  listChapters,
  readChapter,
  buildChapterRelPath,
  writeChapter,
  listLoreItems,
  readLoreItems,
  upsertLoreItems,
  readConfigRedacted,
  listVersions,
  createVersion,
  listAutomations,
  writeAutomations,
  listSkills,
  readSkill,
  createProject,
  outlineCandidates,
  humanizeBytes,
  type LoreItem,
} from "./denova.js";

const server = new McpServer({
  name: "denova-mcp",
  version: "0.1.0",
});

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function json(content: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(content, null, 2) }] };
}

/** A readable file path for a project document, with Denova default fallback. */
function resolveDocDefault(projectDir: string, kind: "outline" | "progress" | "character" | "ideas" | "creator"): string {
  if (kind === "outline") {
    for (const c of outlineCandidates(projectDir)) {
      if (fs.existsSync(path.join(projectDir, c))) return c;
    }
    return "setting/outline.md";
  }
  const map = {
    progress: "setting/progress.md",
    character: "setting/character-states.md",
    ideas: "ideas.md",
    creator: "CREATOR.md",
  } as const;
  return map[kind];
}

function readDoc(projectDir: string, kind: "outline" | "progress" | "character" | "ideas" | "creator", rel?: string) {
  const relPath = rel || resolveDocDefault(projectDir, kind);
  return readFileWithList(projectDir, relPath);
}

// ---------------------------------------------------------------- discovery

server.registerTool(
  "denova_health",
  { title: "检查 Denova MCP 配置", description: "返回 MCP 解析到的 Denova 数据目录、当前作品与作品数量，用于排查 DENOVA_DIR 配置问题。" },
  () => {
    try {
      const home = resolveHomeDir();
      const books = listBooks(home);
      return text(`DENOVA_DIR = ${home}\n作品数 = ${books.length}\n当前作品 = ${currentBook(home) ?? "无"}\n作品: ${books.map((b) => b.name).join("、") || "（无）"}`);
    } catch (e) {
      return text(`配置异常：${(e as Error).message}`);
    }
  }
);

server.registerTool(
  "denova_list_projects",
  {
    title: "列出作品/项目",
    description: "读取 Denova books.json，列出全部作品(book/项目)及其磁盘路径、作者、最近打开时间与当前作品。",
  },
  () => {
    const home = resolveHomeDir();
    const books = listBooks(home);
    const cur = currentBook(home);
    return json({ current: cur, books });
  }
);

server.registerTool(
  "denova_get_project_context",
  {
    title: "获取作品全景上下文",
    description:
      "汇总指定作品的核心创作上下文：CREATOR.md、世界观/大纲、写作进度、角色当前状态、资料库索引(仅 id/名称/类型/重要性)与章节列表。外部 agent 开始创作前应先用本工具获取上下文，避免遗漏设定。",
    inputSchema: { project: z.string().optional().describe("作品名；缺省用当前作品") },
  },
  ({ project }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    const creator = readDoc(dir, "creator");
    const outline = readDoc(dir, "outline");
    const progress = readDoc(dir, "progress");
    const chars = readDoc(dir, "character");
    const chapters = listChapters(dir);
    const lore = listLoreItems(dir);
    const sections: string[] = [];
    sections.push(`# 作品: ${path.basename(dir)}`);
    sections.push(`作品目录: ${dir}`);
    sections.push(`章节数: ${chapters.length}  资料库条目数: ${lore.filter((l) => l.enabled !== false).length}`);

    const push = (label: string, doc: ReturnType<typeof readDoc>) => {
      sections.push(`\n## ${label}`);
      if (!doc.exists) sections.push(`（缺少 ${doc.fullPath}）`);
      else sections.push(`\`\`\`\n${doc.content}\n\`\`\``);
    };
    push("CREATOR.md（全书创作说明/世界观）", creator);
    push("大纲/世界观（outline）", outline);
    push("写作进度（progress）", progress);
    push("角色当前状态（character-states）", chars);

    sections.push("\n## 资料库索引（lore）");
    if (lore.length === 0) sections.push("（无资料库条目）");
    for (const it of lore) {
      sections.push(`- \`${it.id}\` [${it.name ?? it.id}] type=${it.type ?? "other"} importance=${it.importance ?? "?"} enabled=${it.enabled !== false}`);
    }

    sections.push("\n## 章节列表");
    if (chapters.length === 0) sections.push("（暂无章节）");
    for (const c of chapters) {
      sections.push(`- ch${String(c.order).padStart(5, "0")} ${c.title} (${c.relPath}, ${humanizeBytes(c.bytes)})`);
    }
    return text(sections.join("\n"));
  }
);

server.registerTool(
  "denova_list_files",
  {
    title: "列出作品目录结构",
    description: "递归列出作品内全部文件与目录（相对路径）。",
    inputSchema: { project: z.string().optional().describe("作品名；缺省用当前作品"), max_depth: z.number().optional().describe("最大深度") },
  },
  ({ project, max_depth }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    return json(listProjectFiles(dir, max_depth ?? 6));
  }
);

// ---------------------------------------------------------------- generic files

server.registerTool(
  "denova_read_file",
  {
    title: "读取作品内文件",
    description: "读取作品内任意文件的原始文本（相对路径，例如 chapters/ch00001-xxx.md、CREATOR.md、setting/outline.md）。",
    inputSchema: {
      project: z.string().optional().describe("作品名；缺省用当前作品"),
      path: z.string().describe("相对作品根目录的文件路径"),
    },
  },
  ({ project, path: rel }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    const doc = readFileWithList(dir, rel);
    if (!doc.exists) throw new Error(`文件不存在：${rel}`);
    return text(doc.content!);
  }
);

server.registerTool(
  "denova_write_file",
  {
    title: "写入/覆盖作品内文件",
    description: "写入作品内任意文件（相对路径），自动创建父目录并覆盖。用于维护 CREATOR.md、想法、参考资料等文本文件。",
    inputSchema: {
      project: z.string().optional().describe("作品名；缺省用当前作品"),
      path: z.string().describe("相对作品根目录的文件路径"),
      content: z.string().describe("写入的完整文本内容"),
    },
  },
  ({ project, path: rel, content }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    const full = path.join(dir, rel);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(dir))) {
      throw new Error(`拒绝写入作品目录之外的文件：${rel}`);
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf-8");
    return text(`已写入 ${rel}（${humanizeBytes(Buffer.byteLength(content))}）`);
  }
);

// ---------------------------------------------------------------- chapters

server.registerTool(
  "denova_list_chapters",
  {
    title: "列出章节",
    description: "按顺序列出全部章节（编号、标题、相对路径、大小）。章节目录可能为 flat 或按卷分组。",
    inputSchema: { project: z.string().optional().describe("作品名；缺省用当前作品") },
  },
  ({ project }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    return json(listChapters(dir));
  }
);

server.registerTool(
  "denova_read_chapter",
  {
    title: "读取章节正文",
    description: "按章节编号(order，例如 5)或路径/标题读取某一章正文。正文为纯自然段文本，可能较长。",
    inputSchema: {
      project: z.string().optional().describe("作品名；缺省用当前作品"),
      chapter: z.union([z.number(), z.string()]).describe("章节编号或相对路径/标题"),
    },
  },
  ({ project, chapter }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    const doc = readChapter(dir, chapter);
    if (!doc) throw new Error(`找不到该章节：${chapter}`);
    return text(`# ${doc.relPath}\n\n${doc.content}`);
  }
);

server.registerTool(
  "denova_write_chapter",
  {
    title: "写入/新增章节",
    description:
      "创建或覆盖某一章正文。默认按下一编号自动命名(ch00001-标题.md)；若作品使用卷分组则自动放入对应卷目录。续写流程建议：先读 outline/progress/character-states 与前两章，再写入正文，随后更新 progress 与 character-states。可用 path 显式指定相对路径以覆盖指定章。",
    inputSchema: {
      project: z.string().optional().describe("作品名；缺省用当前作品"),
      title: z.string().describe("章节标题（用于自动命名）"),
      body: z.string().describe("章节正文（纯自然段，空格分隔段落）"),
      order: z.number().optional().describe("章节编号（缺省自动取下一编号）"),
      path: z.string().optional().describe("显式相对路径（例如 chapters/ch00003-xxx.md）；指定后不再自动命名"),
    },
  },
  ({ project, title, body, order, path: rel }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    let target = rel;
    if (!target) target = buildChapterRelPath(dir, { title, body, order });
    writeChapter(dir, target, body);
    return text(`已写入章节 ${target}（${humanizeBytes(Buffer.byteLength(body))}）`);
  }
);

// ---------------------------------------------------------------- outline / planning

server.registerTool(
  "denova_read_outline",
  {
    title: "读取大纲/世界观",
    description: "读取作品长期大纲(默认 setting/outline.md，兼容根目录 大纲.md)。续写时作为长期结构参考，通常不修改。",
    inputSchema: { project: z.string().optional().describe("作品名；缺省用当前作品"), path: z.string().optional().describe("可选，显式指定大纲文件相对路径") },
  },
  ({ project, path: p }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    const doc = readDoc(dir, "outline", p);
    return doc.exists ? text(doc.content!) : text(`（作品没有大纲文件 ${doc.fullPath}）`);
  }
);

server.registerTool(
  "denova_write_outline",
  {
    title: "写入大纲/世界观",
    description: "覆盖写入作品大纲文件（默认 setting/outline.md；可用 path 指定其他文件，如根目录 大纲.md）。仅在大纲确有变化时使用。",
    inputSchema: {
      project: z.string().optional().describe("作品名；缺省用当前作品"),
      content: z.string().describe("大纲完整文本"),
      path: z.string().optional().describe("可选目标文件相对路径"),
    },
  },
  ({ project, content, path: p }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    const rel = p || resolveDocDefault(dir, "outline");
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    return text(`已写入大纲 ${rel}`);
  }
);

server.registerTool(
  "denova_read_progress",
  {
    title: "读取写作进度",
    description: "读取写作进度(setting/progress.md)：当前进度、已完成章节摘要、短期衔接提示。续写前必须参考。",
    inputSchema: { project: z.string().optional().describe("作品名；缺省用当前作品") },
  },
  ({ project }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    const doc = readDoc(dir, "progress");
    return doc.exists ? text(doc.content!) : text(`（缺少 ${doc.fullPath}）`);
  }
);

server.registerTool(
  "denova_write_progress",
  {
    title: "更新写作进度",
    description: "覆盖写入写作进度(setting/progress.md)。完成一(几)章后应更新当前进度与本章摘要；纯润色无需更新。",
    inputSchema: { project: z.string().optional().describe("作品名；缺省用当前作品"), content: z.string().describe("进度文件完整文本") },
  },
  ({ project, content }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    const full = path.join(dir, "setting", "progress.md");
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    return text("已更新写作进度 setting/progress.md");
  }
);

server.registerTool(
  "denova_read_character_states",
  {
    title: "读取角色当前状态",
    description: "读取角色当前状态(setting/character-states.md)：每个角色的位置、身体/心理状态、目标、持有物、能力、关系、最近出场、待回收伏笔。续写前必须参考。",
    inputSchema: { project: z.string().optional().describe("作品名；缺省用当前作品") },
  },
  ({ project }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    const doc = readDoc(dir, "character");
    return doc.exists ? text(doc.content!) : text(`（缺少 ${doc.fullPath}）`);
  }
);

server.registerTool(
  "denova_write_character_states",
  {
    title: "更新角色当前状态",
    description: "覆盖写入角色当前状态(setting/character-states.md)。完成章节后需同步角色当前状态。",
    inputSchema: { project: z.string().optional().describe("作品名；缺省用当前作品"), content: z.string().describe("角色状态文件完整文本") },
  },
  ({ project, content }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    const full = path.join(dir, "setting", "character-states.md");
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    return text("已更新角色当前状态 setting/character-states.md");
  }
);

server.registerTool(
  "denova_write_ideas",
  {
    title: "追加创作点子",
    description: "向 ideas.md 追加创作点子/想法（不会覆盖已有内容；在文件末尾追加）。",
    inputSchema: { project: z.string().optional().describe("作品名；缺省用当前作品"), note: z.string().describe("要追加的点子文本") },
  },
  ({ project, note }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    const file = path.join(dir, "ideas.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    fs.writeFileSync(file, existing.endsWith("\n") || existing === "" ? existing + `- ${note}\n` : `${existing}\n- ${note}\n`, "utf-8");
    return text("已追加点子到 ideas.md");
  }
);

// ---------------------------------------------------------------- lore / 资料库

server.registerTool(
  "denova_list_lore_items",
  {
    title: "列出资料库条目",
    description: "列出资料库(lore)全部条目索引(id/名称/类型/重要性/标签/简介)。资料库保存角色身份、设定、能力体系、世界规则、地点、势力等稳定 canon。",
    inputSchema: { project: z.string().optional().describe("作品名；缺省用当前作品") },
  },
  ({ project }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    const items = listLoreItems(dir).map((it) => ({
      id: it.id,
      name: it.name,
      type: it.type,
      importance: it.importance,
      enabled: it.enabled !== false,
      tags: it.tags ?? [],
      brief_description: it.brief_description,
    }));
    return json(items);
  }
);

server.registerTool(
  "denova_read_lore_items",
  {
    title: "读取资料库条目详情",
    description: "按 id 读取资料库条目完整内容（含 markdown content）。不传 ids 时返回全部启用条目。写作涉及某设定时先用它加载完整条目。",
    inputSchema: {
      project: z.string().optional().describe("作品名；缺省用当前作品"),
      ids: z.array(z.string()).optional().describe("条目 id 列表；缺省读取全部启用条目"),
    },
  },
  ({ project, ids }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    return json(readLoreItems(dir, ids));
  }
);

server.registerTool(
  "denova_write_lore_items",
  {
    title: "写入/新增资料库条目",
    description:
      "新增或按 id 覆盖资料库条目。仅对角色身份、人设、长期关系、能力体系、世界规则、地点、势力、物品等稳定设定变化使用；不记录每章后的状态抖动。item 至少含 id、name、content；可选 type/importance/tags/brief_description/keywords/enabled。",
    inputSchema: {
      project: z.string().optional().describe("作品名；缺省用当前作品"),
      items: z.array(z.object({
        id: z.string().describe("唯一 id，建议用 char_/place_/item_/faction_ 前缀"),
        name: z.string().describe("条目名称"),
        content: z.string().describe("条目详情（markdown）"),
        type: z.string().optional().describe("类型：character/place/item/faction/location 等"),
        importance: z.string().optional().describe("major/minor"),
        tags: z.array(z.string()).optional(),
        brief_description: z.string().optional(),
        keywords: z.array(z.string()).optional(),
      })).describe("要写入的条目列表"),
    },
  },
  ({ project, items }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    const res = upsertLoreItems(dir, items as LoreItem[]);
    return text(`新增 ${res.added.length} 条：${res.added.join(", ") || "无"}；更新 ${res.updated.length} 条${res.updated.length ? "：" + res.updated.join(", ") : ""}`);
  }
);

// ---------------------------------------------------------------- config

server.registerTool(
  "denova_read_config",
  {
    title: "读取配置(脱敏)",
    description: "读取 Denova 配置 config.toml（优先作品级 .denova/config.toml，否则用户级）。所有 openai_api_key 等密钥一律脱敏，绝不返回明文密钥。",
    inputSchema: { project: z.string().optional().describe("作品名；缺省用当前作品") },
  },
  ({ project }) => {
    const home = resolveHomeDir();
    let dir: string | null = null;
    try {
      dir = resolveProjectDir(home, project);
    } catch {
      dir = null;
    }
    const { text: cfg, scope } = readConfigRedacted(dir);
    return text(`配置作用域: ${scope}\n\n${cfg || "（未找到 config.toml）"}`);
  }
);

// ---------------------------------------------------------------- skills

server.registerTool(
  "denova_list_skills",
  {
    title: "列出 Skills（写作工作流）",
    description: "列出 Denova 内置与作品级写作 Skills（continue/outline/rewrite/lore/novel-heavy 等）。每个 Skill 定义了推荐的写作工作流与约定。",
    inputSchema: { project: z.string().optional().describe("作品名；缺省用当前作品") },
  },
  ({ project }) => {
    const home = resolveHomeDir();
    let dir: string | undefined;
    try {
      dir = resolveProjectDir(home, project);
    } catch {
      dir = undefined;
    }
    return json(listSkills(home, dir));
  }
);

server.registerTool(
  "denova_read_skill",
  {
    title: "读取某个 Skill 的完整指引",
    description: "读取指定写作 Skill 的 SKILL.md 完整内容，外部 agent 可按其中工作流规范操作 Denova 作品。",
    inputSchema: {
      skill: z.string().describe("Skill 目录名，例如 continue / outline / rewrite / lore / novel-heavy"),
      project: z.string().optional().describe("作品名；缺省用当前作品"),
    },
  },
  ({ skill, project }) => {
    const home = resolveHomeDir();
    let dir: string | undefined;
    try {
      dir = resolveProjectDir(home, project);
    } catch {
      dir = undefined;
    }
    const content = readSkill(home, skill, dir);
    if (!content) throw new Error(`找不到 Skill：${skill}`);
    return text(`# Skill: ${skill}\n\n${content}`);
  }
);

// ---------------------------------------------------------------- automations

server.registerTool(
  "denova_list_automations",
  {
    title: "列出自动化任务",
    description: "读取作品级自动化任务(.denova/automations/tasks.json)。",
    inputSchema: { project: z.string().optional().describe("作品名；缺省用当前作品") },
  },
  ({ project }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    return json(listAutomations(dir));
  }
);

server.registerTool(
  "denova_write_automations",
  {
    title: "写入自动化任务",
    description: "整体覆盖写入作品级自动化任务列表(.denova/automations/tasks.json)。请传完整的新列表。",
    inputSchema: {
      project: z.string().optional().describe("作品名；缺省用当前作品"),
      tasks: z.array(z.record(z.any())).describe("自动任务对象列表"),
    },
  },
  ({ project, tasks }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    writeAutomations(dir, tasks);
    return text("已写入自动化任务");
  }
);

// ---------------------------------------------------------------- project create

server.registerTool(
  "denova_create_project",
  {
    title: "新建作品/项目",
    description: "在 Denova 数据目录新建一个作品(book)并登记到 books.json。自动创建 chapters/、setting/、.denova/lore/ 骨架与 CREATOR.md/ideas.md/progress.md/items.json，并设为当前作品。",
    inputSchema: { name: z.string().describe("新作品名称") },
  },
  ({ name }) => {
    const home = resolveHomeDir();
    const dir = createProject(home, name);
    return text(`已创建作品「${name}」\n目录: ${dir}`);
  }
);

// ---------------------------------------------------------------- versions

server.registerTool(
  "denova_list_versions",
  {
    title: "列出版本记录",
    description: "查看作品 Git 版本历史（最近 30 条）。Denova 使用自动版本策略保存在作品目录内。",
    inputSchema: { project: z.string().optional().describe("作品名；缺省用当前作品") },
  },
  async ({ project }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    return text(await listVersions(dir));
  }
);

server.registerTool(
  "denova_create_version",
  {
    title: "创建版本快照",
    description: "为作品创建 Git 提交(自动 add -A + commit)。适合在一批文件改动后保存一个里程碑。",
    inputSchema: {
      project: z.string().optional().describe("作品名；缺省用当前作品"),
      message: z.string().describe("版本说明/提交信息"),
    },
  },
  async ({ project, message }) => {
    const home = resolveHomeDir();
    const dir = resolveProjectDir(home, project);
    return text(await createVersion(dir, message));
  }
);

// ------------------------------------------------------------------ startup

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("[denova-mcp] 启动失败:", e);
  process.exit(1);
});
