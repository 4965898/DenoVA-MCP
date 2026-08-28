# denova-mcp

> 用你自己已订阅的任意 AI Agent / Harness 平台（Claude Code、Cursor、TraeWork、Cline……）为 Denova 写小说。
> Drive [Denova](https://github.com/alfredxw/denova), the open-source AI novel-writing & AI-RPG platform, from **your own** AI agents / harnesses via MCP.

**denova-mcp** 是一个 [Model Context Protocol (MCP)](https://modelcontextprotocol.io) 服务器，让任何 MCP 客户端（AI Agent 软件 / HaaS 平台）能够直接读取和写入 **Denova** 的作品数据——作品、章节、大纲、进度、角色状态、资料库(lore)、配置、Skills、自动化任务与 Git 版本。

不需要 Denova 进程在运行，不需要掌握 Denova 内部 API：MCP 直连 Denova 的数据目录（文件系统），与 Denova 内置 agent 使用的工具协议（`read_file` / `write_file` / `read_lore_items` …）完全一致。

```
┌────────────────────┐       MCP(stdio)       ┌─────────────────────┐
│  你的 AI Agent      │ ◄────────────────────► │   denova-mcp 服务器   │
│ (Claude Code /     │                        └──────────┬──────────┘
│  Cursor / TraeWork  │                                   │ 直接读写文件
│  / 任意 HaaS 平台)  │                                   ▼
└────────────────────┘                        ┌─────────────────────┐
                                             │  Denova 数据目录      │
                                             │  books.json / projects│
                                             └─────────────────────┘
```

## 为什么需要它

Denova 是一款开源 AI 小说创作平台，自带 AI Agent（写作 Agent、互动 Agent 等）。但 Denova 内置 Agent 只接受 **你自己的模型 API 密钥**。

如果你在某个 AI 平台（如 TraeWork、Cursor、Claude Code 等）订阅了会员 / 购买了大量 Credit，而这些 Credit **无法以 API 密钥的形式填入 Denova**——

- ❌ 你无法在 Denova 里使用这些会员额度；
- ✅ 但你可以通过 denova-mcp，**让这些平台直接读写 Denova 的作品文件**，用平台的 LLM 完成创作，把成果写入 Denova。

**换句话说：Denova 负责"存储与组织"，你的 AI Agent 负责"思考与生成"，MCP 是两者之间的桥。**

## 核心特性

- 📚 **作品管理**：列出全部作品、获取作品全景上下文、一键新建作品（book）
- 📝 **章节**：列章、读正文、按 Denova 命名规则**自动命名建章**（`ch00001-标题.md`，自动识别「卷」目录或平铺布局）
- 🗺️ **写作规划**：读写大纲、写作进度、角色当前状态、创作点子
- 🏛️ **资料库 (lore)**：列出/读取/新增/更新稳定设定条目（角色、地点、势力、物品、能力体系、世界规则）
- ⚙️ **配置**：读取 Denova `config.toml`（**API 密钥强制脱敏**，绝不外泄明文密钥）
- 🧩 **Skills / 工作流**：列出并读取 Denova 写作 Skills 指引（continue / outline / rewrite / lore / novel-heavy …），让外部 agent 按官方工作流规范创作
- 🤖 **自动化 & 版本**：读写自动化任务，查看/创建 Git 版本快照
- 🔒 **安全**：仅 stdio 本地通信，不开放网络端口；写操作限定在作品目录内

内置 **27 个工具**（`denova_` 前缀）：

| 类别 | 工具 |
| --- | --- |
| 诊断 / 发现 | `denova_health` · `denova_list_projects` · `denova_get_project_context` · `denova_list_files` |
| 通用文件 | `denova_read_file` · `denova_write_file` |
| 章节 | `denova_list_chapters` · `denova_read_chapter` · `denova_write_chapter` |
| 写作规划 | `denova_read_outline` · `denova_write_outline` · `denova_read_progress` · `denova_write_progress` · `denova_read_character_states` · `denova_write_character_states` · `denova_write_ideas` |
| 资料库 lore | `denova_list_lore_items` · `denova_read_lore_items` · `denova_write_lore_items` |
| 配置 | `denova_read_config` |
| Skills | `denova_list_skills` · `denova_read_skill` |
| 自动化 | `denova_list_automations` · `denova_write_automations` |
| 作品 | `denova_create_project` |
| 版本 | `denova_list_versions` · `denova_create_version` |

## 环境要求

- Node.js ≥ 18（推荐 20+）
- 一个已安装的 Denova 本地部署（包含 `books.json` 与 `projects/` 的数据目录）

## 安装

```bash
git clone <your-repo-url> denova-mcp
cd denova-mcp
npm install
npm run build        # 产出 dist/index.js
```

> 无需准备环境变量即可构建；运行时才需要 `DENOVA_DIR`（见下）。

## 配置：定位 Denova 数据目录

MCP 需要知道你的 Denova **数据目录**——即包含 `books.json` 的那一层。二选一：

**方式 A —— 环境变量 `DENOVA_DIR`（推荐）**

```text
DENOVA_DIR = /path/to/denova/.denova
```

Windows 示例：

```text
DENOVA_DIR = D:\DenovaData\.denova
```

**方式 B —— 项目内配置文件 `.denova-mcp.json`**

在 MCP 客户端的**工作目录**放置：

```json
{ "denovaDir": "/path/to/denova/.denova" }
```

可用 `denova_health` 工具验证配置是否正确。

## 接入各种 MCP 客户端

MCP 服务器走 **stdio** 传输，启动命令为：

```bash
node <absolute-path>/dist/index.js
```

### Claude Desktop（`claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "denova": {
      "command": "node",
      "args": ["/absolute/path/to/denova-mcp/dist/index.js"],
      "env": { "DENOVA_DIR": "/path/to/denova/.denova" }
    }
  }
}
```

### Cursor / VS Code / TraeWork 等 IDE

```json
{
  "mcpServers": {
    "denova": {
      "command": "node",
      "args": ["D:\\path\\to\\denova-mcp\\dist\\index.js"],
      "env": { "DENOVA_DIR": "D:\\DenovaData\\.denova" },
      "disabled": false
    }
  }
}
```

接入后调用 `denova_health` 应返回类似：

```
DENOVA_DIR = D:\DenovaData\.denova
作品数 = 2
当前作品 = 示例作品名
```

## 推荐创作工作流（给 AI Agent 的提示词建议）

1. **先取上下文**：调用 `denova_get_project_context` 获取作品全景（CREATOR.md / 大纲 / 进度 / 角色状态 / 资料库索引 / 章节列表）；或按需 `denova_read_outline` / `denova_read_progress` / `denova_read_character_states` / `denova_list_lore_items` / `denova_read_skill(continue)`。
2. **读前文**：续写前调用 `denova_read_chapter` 读最近两章；涉及既有设定时用 `denova_read_lore_items` 加载条目详情。
3. **写正文**：调用 `denova_write_chapter`（可用 `path` 精确指定章节，或让工具自动命名）。
4. **同步状态**：写完后调用 `denova_write_progress` 更新进度与摘要、`denova_write_character_states` 同步角色状态；**仅当长期设定发生明确变化**才用 `denova_write_lore_items` 更新资料库。
5. **打版本**（可选）：`denova_create_version` 创建 Git 快照。

## Denova 数据模型速览

denova-mcp 直接操作以下 Denova 文件结构：

```
<denova 数据目录>/
├── books.json                      # 作品注册表（当前作品 + 作品列表）
├── config.toml                     # 用户级配置（含模型/密钥 → MCP 脱敏读取）
└── projects/
    └── <书名>/
        ├── chapters/               # 章节正文（markdown，可平铺或按卷分组）
        │   ├── ch00001-标题.md
        │   └── v00001-第1卷/
        ├── setting/                # 创作元数据
        │   ├── outline.md          # 大纲 / 世界观
        │   ├── progress.md         # 写作进度 + 章节摘要
        │   └── character-states.md # 角色当前状态
        ├── CREATOR.md              # 全书创作说明 / 写作约定
        ├── ideas.md                # 点子
        └── .denova/
            ├── lore/items.json     # 资料库（稳定设定，version2）
            ├── automations/tasks.json # 自动化任务
            ├── config.toml         # 作品级配置
            └── sessions/           # AI Agent 会话记录
```

## 开发和测试

```bash
npm run typecheck          # 类型检查
npm run build              # 编译到 dist/
npm run dev                # 以 tsx 直接运行源码
node scripts/smoke.mjs     # 冒烟测试（真实目录只读 + 临时目录写入）
```

## 目录结构

```
denova-mcp/
├── src/
│   ├── index.ts    # MCP 服务器入口 + 27 个工具注册
│   ├── denova.ts   # Denova 文件系统客户端（发现/章节/资料库/版本/配置）
│   └── toml.ts     # 最小 TOML 解析 + 密钥脱敏
├── scripts/
│   └── smoke.mjs   # stdio JSON-RPC 冒烟测试
├── package.json
└── tsconfig.json
```

## 安全说明

- `denova_read_config` 对 `openai_api_key` / `api_key` / `token` / `secret` 等领域**强制脱敏**，返回值中不会出现明文密钥。
- 写操作按相对路径限定在作品目录内；`denova_write_file` 会拒绝指向作品目录之外的真实路径。
- 服务器仅通过本地 stdio 与 MCP 客户端通信，**不监听任何网络端口**，不引入远程地址。
- ⚠️ 写操作会直接修改你的真实作品文件——使用前请务必备份。

## 常见问题（FAQ）

**Q：Denova 需要正在运行吗？**
A：不需要。denova-mcp 直接读写数据目录，Denova 进程不参与。

**Q：为什么不在 MCP 里调用 Denova 内置 AI Agent？**
A：这超出了"数据层直连"的定位。denova-mcp 定位于让**你自己的 AI Agent** 完成生成与写入，从而绕开 Denova 自带 Agent 对模型/密钥的依赖。若需 Denova 内置引擎能力（互动模式/TRPG、图像生成等），属于另一层面的集成方向。

**Q：章节为什么有时候平铺、有时候进卷目录？**
A：这是 Denova 自身的布局策略——若作品已有章节在子目录（卷）中，新章节自动归入对应卷目录；否则平铺在 `chapters/` 下。工具自动适配，无需手工指定。

## 贡献

欢迎提交 Issue 与 PR：

1. Fork 本仓库
2. 新建特性分支
3. 提交更改（遵循现有代码风格，工具名保持 `denova_` 前缀）
4. 运行 `npm run build` 与 `node scripts/smoke.mjs` 确保通过
5. 发起 Pull Request

## 致谢与许可

- 本项目的目标平台 [Denova](https://github.com/alfredxw/denova)（Apache-2.0），一个支持 AI Agents / Skills / Subagent Workflows / Automations / 图像生成 / 版本管理的 AI 小说创作与 AI-RPG 平台
- 构建于 [TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)

**License: [Apache-2.0](./LICENSE)**

---

*Disclaimer：本 MCP 为独立开源项目，与 Denova 官方无隶属关系。*
