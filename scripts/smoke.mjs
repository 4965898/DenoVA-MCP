// Smoke test for denova-mcp over stdio JSON-RPC.
//   * mutating tools  -> run against a throwaway temp DENOVA_DIR (always)
//   * read-only tools -> also run against a real Denova dir when DENOVA_DIR is set
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REAL_DIR = process.env.DENOVA_DIR;

class Client {
  constructor(child) {
    this.child = child;
    this.buf = "";
    this.pending = new Map();
    this.nextId = 1;
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (d) => this._onData(d));
    child.stderr.on("data", (d) => process.stderr.write("[srv-log] " + d));
  }
  _onData(d) {
    this.buf += d;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch (e) {
        // ignore non-JSON / follow-up notifications
      }
    }
  }
  _send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }
  async init() {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1.0" },
    });
    this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  call(tool, args) {
    return this.request("tools/call", { name: tool, arguments: args || {} });
  }
  close() {
    return new Promise((r) => {
      this.child.stdin.end();
      this.child.on("exit", r);
    });
  }
}

async function main() {
  // ---- Part 1 (optional): read-only against a real Denova dir ----
  if (REAL_DIR && fs.existsSync(REAL_DIR)) {
    await runReadOnlyPart();
  } else {
    console.log("SKIP read-only part: set DENOVA_DIR to a real Denova data dir to enable it.");
  }

  // ---- Part 2: mutation against a temp dir ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "denova-mcp-smoke-"));
  fs.mkdirSync(path.join(tmp, "projects"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "books.json"),
    JSON.stringify({ current: "", books: [], sort_mode: "recent" }, null, 2)
  );
  console.log("\nTEMP DENOVA_DIR:", tmp);
  const ts = spawn(process.execPath, ["dist/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, DENOVA_DIR: tmp },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const c2 = new Client(ts);
  await c2.init();

  const tools = await c2.request("tools/list", {});
  console.log("TOOL COUNT:", tools.tools.length);
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));

  await callOrg(c2, "denova_create_project", { name: "测试小说" });
  await callOrg(c2, "denova_write_chapter", {
    title: "开端",
    body: "清晨。\n\n她推开门。",
  });
  await callOrg(c2, "denova_write_chapter", {
    title: "旅途",
    body: "次日。\n\n她启程。",
  });
  await callOrg(c2, "denova_list_chapters", {});
  await callOrg(c2, "denova_write_lore_items", {
    items: [
      { id: "char_mei", name: "女孩", content: "主角。", type: "character", importance: "major", tags: [] },
    ],
  });
  await callOrg(c2, "denova_read_lore_items", { ids: ["char_mei"] });
  await callOrg(c2, "denova_write_progress", { content: "# 写作进度\n\n- 已完成 ch00002\n" });

  const chs = fs
    .readdirSync(path.join(tmp, "projects", "测试小说", "chapters"))
    .sort();
  console.log("\ncreated chapter files in chapters/:", chs);
  if (chs.join(",") !== "ch00001-开端.md,ch00002-旅途.md") {
    console.error("!! FAIL: chapter auto-naming/layout mismatch ->", chs);
    process.exit(1);
  }
  await c2.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\nSMOKE TEST PASSED");
}

// Read-only checks against a real Denova data directory.
async function runReadOnlyPart() {
  console.log("\nREAL DENOVA_DIR:", REAL_DIR);
  const real = spawn(process.execPath, ["dist/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, DENOVA_DIR: REAL_DIR },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const c1 = new Client(real);
  await c1.init();

  const tools = await c1.request("tools/list", {});
  console.log("TOOL COUNT:", tools.tools.length);

  const call = async (name, args) => {
    const r = await c1.call(name, args);
    const text = (r.content || []).map((x) => x.text || "").join("");
    console.log(`\n### call ${name} ->`);
    console.log(text.slice(0, 1200));
    return text;
  };

  await call("denova_health", {});
  await call("denova_list_projects", {});
  const cfg = await call("denova_read_config", {});
  const cfgLower = (cfg || "").toLowerCase();
  if (/sk-|aiya|ak_[0-9a-z]|apikey/.test(cfgLower.replace(/redacted:api_key_hidden/g, ""))) {
    console.error("!! FAIL: config appears to leak a secret");
    process.exit(1);
  }
  console.log("redaction: OK (no secret in config output)");
  await call("denova_get_project_context", {});
  await call("denova_list_chapters", {});
  await call("denova_list_lore_items", {});
  await call("denova_list_versions", {});
  await c1.close();
}

async function callOrg(client, name, args) {
  const r = await client.call(name, args);
  const text = (r.content || []).map((x) => x.text || "").join("");
  console.log(`\n### ${name} ->\n${text}`);
}

main().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
