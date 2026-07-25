// BagIdea Office — daemon v3 (Layer 0).
// Zero-dependency event hub + Claude Code adapter + permission broker:
//   HTTP :8787  GET  /              → Layer-2 overlay (chat panel web app)
//   WS   :8787  GET  /ws (upgrade)  → event stream for renderers + overlays
//                                      (new clients get a journal replay first)
//               POST /chat          → spawn a real Claude Code session
//               POST /event         → adapters push events (hooks, tests)
//               POST /perm/request  → PreToolUse hook long-polls for a decision
//               POST /perm/respond  → overlay/user answers {id, decision}
//               GET  /health
//
// Every event is journaled to journal.jsonl — restarted clients replay the
// tail to rebuild their state.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const {
  REPLAY_COUNT,
  MAX_STAFF,
  BUILTIN_TOOLS,
  SKILL_LIBRARY,
  DEFAULT_MAIN_AGENT,
  DEFAULT_CEO_AGENT,
} = require("./constants");
const maintenance = require("./maintenance");
const retrieval = require("./retrieval");
const skillsSync = require("./skills");
const providers = require("./providers");
const proxy = require("./proxy");
const { RunWatchdog } = require("./watchdog");
const { wireWorkspaceSettings } = require("./wire-hooks-runtime");
const { killTree } = require("./kill-tree"); // cross-platform child reap (issue #15 review)

// WSL hybrid mode (daemon in WSL, GUI on Windows). Two sides:
//  • In WSL, wslx routes window/file/dialog work to the Windows side via
//    interop (explorer.exe, powershell.exe, wt.exe run fine from WSL).
//  • On win32 with daemon/hybrid.txt present, the REAL daemon lives in WSL —
//    the shell's watchdog can't know that, so when it spawns us here we boot
//    the WSL daemon instead and bow out. Without this, a WSL daemon hiccup
//    would silently fork a second data store on the Windows side.
const wslx = require("./wsl");
if (wslx.hybridBounce(__dirname)) process.exit(0);

// Issue #15 (Bug 1) — main runs need both a hard wall-clock cap and an idle
// detector, or a stuck CLI retry loop pins a task in "started" until the CLI
// gives up on its own (observed: 14 min). Sub-agents already have a 6-min
// watchdog; these apply to the main runClaude() path.
const RUN_TOTAL_MS = Number(process.env.OFFICE_RUN_TOTAL_MS) || 30 * 60000; // 30 min hard cap
const RUN_IDLE_MS = Number(process.env.OFFICE_RUN_IDLE_MS) || 5 * 60000; // 5 min no-progress

const WORKSPACE = path.join(__dirname, "..", "workspace");
// Server-local paths (the refactor moved REPLAY_COUNT to constants.js but these
// two are used right here — broadcast() journals to JOURNAL, GET / serves OVERLAY).
const OVERLAY = path.join(__dirname, "overlay.html");
const JOURNAL = path.join(__dirname, "journal.jsonl");

const wsClients = new Set();
const pendingPerms = new Map(); // id -> {res, timer, agent, tool}
let taskCounter = 0;

// ---------------------------------------------------------------- registry
// Persistent staff roster + roles (skills/tools libraries ride along).
// main = Claude, the undeletable Director; ceo = the human owner's avatar.

const REGISTRY = path.join(__dirname, "registry.json");
let reg;

// Starter skill library — the capability pack every office ships with, in the
// spirit of the curated skills other agent stacks bundle. Each entry is plain
// instruction content injected into an assigned agent's persona. They're
// seeded into reg.skills as `builtin` (refreshed on update, never clobbering a
// user's own skills) and assignable from the editor. Auto-learned skills
// (maybeLearnSkill) grow the library further while the office runs.
function loadReg() {
  try {
    reg = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  } catch {
    reg = {};
  }
  reg.agents = reg.agents || {};
  reg.apiKeys = reg.apiKeys || {}; // ENV_NAME → value (injected into runs)
  reg.channels = reg.channels || {}; // telegram/discord/line connector config
  // MAIN keys power program features (voice, TTS, image…). Canonical names —
  // migrate the short forms users typed before this distinction existed.
  if (reg.apiKeys.OPENAI && !reg.apiKeys.OPENAI_API_KEY) {
    reg.apiKeys.OPENAI_API_KEY = reg.apiKeys.OPENAI;
    delete reg.apiKeys.OPENAI;
  }
  if (reg.apiKeys.GEMINI && !reg.apiKeys.GEMINI_API_KEY) {
    reg.apiKeys.GEMINI_API_KEY = reg.apiKeys.GEMINI;
    delete reg.apiKeys.GEMINI;
  }
  // Per-agent model/provider routing (the swappable brain). Per-provider creds +
  // optional baseUrl/model overrides live here; agents opt in via a.provider.
  reg.providerConfig = reg.providerConfig || {}; // { glm:{token}, litellm:{baseUrl,token}, ... }
  reg.roles = reg.roles || [
    "Director",
    "Founder",
    "Researcher",
    "Engineer",
    "Designer",
    "Analyst",
    "Operator",
    "Specialist",
  ];
  reg.skills = reg.skills || {};
  // Seed / refresh the builtin starter library. We own entries flagged
  // `builtin` (so updates propagate new wording), but never touch a user's
  // own skills or auto-learned ones.
  for (const [id, sk] of Object.entries(SKILL_LIBRARY)) {
    const cur = reg.skills[id];
    if (!cur || cur.builtin) reg.skills[id] = { ...sk, builtin: true };
  }
  reg.tools = Object.keys(BUILTIN_TOOLS);
  reg.mcpServers = reg.mcpServers || {};
  // One-time seed: a ready-to-use WEB capability (Playwright MCP, the Claude Code
  // browser standard). Tick "🔌 web" on an agent's tools and it can navigate,
  // click, type, submit forms and screenshot real pages. Runs --isolated (a fresh
  // profile, NOT logged in — fresh state each run) and --headed so you can watch
  // it work. Seeded once (reg.seededWebMcp) so removing it in the UI sticks.
  if (!reg.seededWebMcp) {
    if (!reg.mcpServers.web)
      // 👀 visible — watch it work
      reg.mcpServers.web = {
        command: "npx -y @playwright/mcp@latest --headed --isolated",
      };
    reg.seededWebMcp = true;
  }
  if (!reg.seededWebBg) {
    if (!reg.mcpServers["web-bg"])
      // 🤫 headless — runs in the background
      reg.mcpServers["web-bg"] = {
        command: "npx -y @playwright/mcp@latest --headless --isolated",
      };
    reg.seededWebBg = true;
  }
  reg.places = reg.places || {}; // shorthand locations: "ห้องสมุด" → folder
  // Default main agent: SHINO — the owner's (CEO's) second-in-command who runs
  // the floor. A manager, not an individual contributor: few hands-on tools,
  // delegation as his craft. Playful but serious about the work.
  if (!reg.agents.main) reg.agents.main = DEFAULT_MAIN_AGENT;
  if (!reg.agents.ceo) reg.agents.ceo = DEFAULT_CEO_AGENT;
  // One-time: hand the EXISTING Director the web skill too (it's now a default,
  // and web browsing is a flagship capability). Fresh installs already have it via
  // DEFAULT_MAIN_AGENT. Gated so removing it in the UI sticks.
  if (!reg.seededDirectorWeb) {
    const m = reg.agents.main;
    if (m && Array.isArray(m.skills) && !m.skills.includes("web-automation"))
      m.skills.push("web-automation");
    reg.seededDirectorWeb = true;
  }
  // Default office rhythms for a fresh install (owner can change in settings).
  if (reg.heartbeatMin === undefined) reg.heartbeatMin = 60; // Director check-in
  if (reg.socialMin === undefined) reg.socialMin = 120; // agents socialize (economical default)
  if (reg.proposalMin === undefined) reg.proposalMin = 120; // min gap between CEO pitches
  saveReg();
}
function saveReg() {
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
}
loadReg();

// Live (not journaled): registry.json is the persistence; every WS client
// also gets a fresh snapshot on connect.
// Hire cap: the office floor is small and sub-agents (👻 ghosts) handle
// parallel load — keep the staff to MAX_STAFF (CEO not counted). Shared by the
// hire endpoint and the roster sync (so the UI can show "N/MAX").
function staffCount() {
  return Object.keys(reg.agents).filter((k) => k !== "ceo").length;
}

// ---- Workflow Builder (human-language nodes the Director analyzes) ----------
// Nodes form a graph via edges (A → B = do B after A). A node with several
// outgoing edges = parallel branches; several incoming = wait for all, then
// continue. Falls back to top→bottom by Y when no edges are drawn.
function workflowToText(w) {
  const nodes = w.nodes || [];
  const edges = w.edges || [];
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  const label = (id) => {
    const n = byId[id];
    return n ? `[${n.type || "step"}] ${(n.text || "").trim()}` : id;
  };
  let s = `Workflow: ${w.name || "(untitled)"}\n\nSteps:\n`;
  nodes
    .slice()
    .sort((a, b) => (a.y || 0) - (b.y || 0))
    .forEach((n, i) => {
      s += `(${i + 1}) ${label(n.id)}\n`;
    });
  if (edges.length) {
    s +=
      "\nFlow (A → B = do B after A; a node with several outgoing arrows runs those " +
      "branches in PARALLEL; a node with several incoming arrows WAITS for all of them " +
      "before continuing):\n";
    for (const e of edges) s += `- ${label(e.from)}  →  ${label(e.to)}\n`;
  } else {
    s +=
      "\n(No connections drawn — treat the steps in order, top to bottom.)\n";
  }
  return s;
}
// Turn an ordered list of plain-language steps into a Builder workflow ({id,name,
// nodes,edges}) — a trigger entry node, then one action node per step, chained top to
// bottom. Shared by the agent WORKFLOW: protocol and the Director-draft endpoint.
function buildWorkflowFromSteps(name, steps) {
  const clean = (steps || [])
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .slice(0, 24);
  const nodes = [],
    edges = [];
  let i = 1,
    y = 40;
  const x = 80;
  const push = (type, text) => {
    const id = "n" + i++;
    nodes.push({ id, type, text: String(text).slice(0, 300), x, y });
    y += 150;
    return id;
  };
  let prev = push("trigger", "開始の指示があったとき");
  clean.forEach((s) => {
    const id = push("action", s);
    edges.push({ from: prev, to: id });
    prev = id;
  });
  return { name: String(name || "Workflow").slice(0, 60), nodes, edges };
}

// Catch `WORKFLOW: <name> :: step1 ; step2 ; step3` lines in an agent's reply (steps
// split on ; > → • | or numbering) and save each as an editable workflow file. Returns
// { text } with the lines stripped, and { created:[{id,name}] }.
function harvestWorkflows(text) {
  const created = [],
    keep = [];
  for (const ln of String(text || "").split("\n")) {
    const m = ln.match(/^\s*WORKFLOW:\s*(.+?)\s*::\s*(.+)$/i);
    if (!m) {
      keep.push(ln);
      continue;
    }
    const name = m[1].trim();
    const steps = m[2]
      .split(/\s*(?:;|>|→|•|\||(?:^|\s)\d+[.)])\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!name || !steps.length) {
      keep.push(ln);
      continue;
    }
    try {
      const w = buildWorkflowFromSteps(name, steps);
      w.id = "wf_" + Date.now() + "_" + created.length;
      const dir = path.join(WORKSPACE, "workflows");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, w.id + ".json"),
        JSON.stringify(w, null, 2),
      );
      created.push({ id: w.id, name: w.name });
      broadcast({ type: "workflow.created", id: w.id, name: w.name });
    } catch (e) {
      console.error("[workflow] save failed:", e && e.message);
      keep.push(ln);
    }
  }
  return { text: keep.join("\n"), created };
}

const WORKFLOW_ANALYZE_PROMPT = [
  "ユーザーが下に workflow を人間の言葉（node の順序）で置きました。Director として、",
  "これをどう実現するかを分析してください — 今は着手せず、計画だけ立てます。項目立てで簡潔に、",
  "読みやすく、ユーザーと同じ言語で答えてください：",
  "1) この workflow が何をするものか 1〜2 行で要約",
  "2) 各ステップにどの skill/tool が必要か（例：WebSearch, Bash, Write）— 適した skill がまだ無ければ、どんな名前で何をする skill を作るべきか示す",
  "3) agent にどの permission/tool を追加で開放する必要があるか",
  "4) どの agent に任せるべきか、または新しい agent を雇うべきか（役割は何か）",
  "5) 実際に実行する前にユーザーが判断すべき疑問点・抜け漏れ",
].join("\n");

// Which program features the MAIN keys currently unlock — booleans only,
// never the keys themselves. Rides on roster.sync so the UI gates live.
function featuresMap() {
  const k = reg.apiKeys || {};
  const oa = !!k.OPENAI_API_KEY,
    gm = !!k.GEMINI_API_KEY;
  return {
    openai: oa,
    gemini: gm,
    stt: oa || gm,
    tts: gm,
    live: gm,
    image: oa || gm,
  };
}

// How many physical monitors the shell detected at attach time (it writes the
// count to daemon/monitors.txt). The UI shows a display picker only when >1, and
// lists exactly this many — no more guessing "3" when there's one screen.
function monitorCount() {
  try {
    const n = parseInt(
      fs.readFileSync(path.join(__dirname, "monitors.txt"), "utf8").trim(),
      10,
    );
    return n >= 1 ? n : 1;
  } catch {
    return 1;
  }
}

function rosterEvt() {
  return {
    type: "roster.sync",
    agents: reg.agents,
    roles: reg.roles,
    tools: reg.tools,
    builtinTools: BUILTIN_TOOLS,
    mcp: reg.mcpServers,
    skills: reg.skills,
    autoSkills: reg.autoSkills !== false,
    verifyDelegated: reg.verifyDelegated === true,
    sound: reg.sound !== false,
    heartbeatMin: Number(reg.heartbeatMin || 0),
    features: featuresMap(),
    tts: reg.tts !== false,
    ambient: reg.ambient !== false,
    socialMin: Number(reg.socialMin !== undefined ? reg.socialMin : 60),
    proposalMin: Number(reg.proposalMin !== undefined ? reg.proposalMin : 120),
    maxStaff: MAX_STAFF,
    staffCount: staffCount(),
    lang: reg.lang || "en",
    daylight: reg.daylight ?? "auto",
    monitor: reg.monitor || 0,
    monitors: monitorCount(),
  };
}

// Relaunch the whole stack (shell → daemon → godot) detached, so it survives
// killAll killing THIS daemon. Used after a monitor change so the wallpaper
// re-attaches to the chosen screen without the user typing `bagidea restart`.
function triggerRestart() {
  try {
    const { spawn } = require("child_process");
    // Hybrid (daemon in WSL, GUI on Windows): the Linux CLI can't reach the
    // Windows shell/Godot, so restart through the Windows-side launcher —
    // it tears BOTH sides down and boots them back in order. The interop
    // stub is detached and doesn't match the launcher's pkill pattern, so
    // it survives this daemon being killed mid-restart.
    if (wslx.isWSL() && wslx.guiRoot()) {
      const ps1 = wslx.toWinPath(
        path.join(wslx.guiRoot(), "run-hybrid-windows.ps1"),
      );
      if (ps1) {
        const c = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            ps1,
            "-Restart",
          ],
          { detached: true, stdio: "ignore", cwd: wslx.INTEROP_CWD },
        );
        c.on("error", (e) =>
          console.error("[hybrid] restart via launcher failed:", e.message),
        );
        c.unref();
        return;
      }
    }
    const cli = path.join(__dirname, "..", "cli", "bagidea.js");
    const root = path.join(__dirname, "..");
    if (process.platform === "win32") {
      // Launch through `start` so the restarter is ORPHANED from this daemon's
      // process tree. The restarter runs `bagidea restart`, whose killAll does
      // `taskkill /T` on the daemon — and /T kills the daemon's whole child tree.
      // A plain detached spawn is still our child (PPID), so it would be killed
      // mid-flight before it could relaunch. `start` re-parents it away.
      spawn(
        "cmd",
        ["/c", "start", "", "/min", process.execPath, cli, "restart"],
        { detached: true, stdio: "ignore", windowsHide: true, cwd: root },
      ).unref();
    } else {
      spawn(process.execPath, [cli, "restart"], {
        detached: true,
        stdio: "ignore",
        cwd: root,
      }).unref();
    }
  } catch (e) {
    console.error("[restart]", e.message);
  }
}

// Structured persona → one compiled system prompt (editor v2 fields).
function personaText(a) {
  let p = a.prompt || "";
  const px = a.persona || {};
  if (px.expertise) p += `\n\n専門分野 / 業務範囲：\n${px.expertise}`;
  if (px.personality) p += `\n\n性格と口調：\n${px.personality}`;
  if (px.language) p += `\n\n回答に使う主な言語：${px.language}`;
  if (px.rules) p += `\n\n業務ルール（常に厳守すること）：\n${px.rules}`;
  // The assigned voice fixes the agent's gender (♀/♂ on the preset) — state it so
  // the agent refers to itself consistently in any language (Thai ครับ/ผม vs ค่ะ/ฉัน,
  // pronouns, honorifics) and never contradicts the voice the CEO actually hears.
  if (a.voice && VOICE_PRESETS[a.voice]) {
    p +=
      voiceGender(a.voice) === "m"
        ? "\n\nあなたの性別：男性 — 回答するどの言語でも常に男性として自分を呼び、男性らしく話すこと " +
          "(日本語では男性的な一人称・話し方を使う) あなたの声に合わせ、女性のような話し方はしないこと"
        : "\n\nあなたの性別：女性 — 回答するどの言語でも常に女性として自分を呼び、女性らしく話すこと " +
          "(日本語では女性的な一人称・話し方を使う) あなたの声に合わせ、男性のような話し方はしないこと";
  }
  return p;
}
function pushRoster() {
  broadcast(rosterEvt(), false);
}

function slugId(name) {
  const s = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9ก-๙]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return s || "agent" + (Date.now() % 10000);
}

// Hermes-style auto-skills: after a real multi-tool task, a quick
// reflection call decides whether the work distills into a reusable skill.
// New skills land in the registry, auto-assigned to the agent that earned
// them, and the office hears about it (skill.created).
let _lastSkillLearn = 0;
const SKILL_COOLDOWN_MS = 15 * 60 * 1000;
async function maybeLearnSkill(agent, task, prompt, acts, finalText, projId) {
  if (reg.autoSkills === false) return;
  // Adaptive: reflection is a full Claude run, so on a MATURE office (already has a
  // healthy auto-learned library) firing it after every task ~doubled the bill — throttle
  // there (>=5 tools, once / 15 min). But while the office is YOUNG, learn EAGERLY
  // (>=3 tools, no cooldown) so a new user actually SEES their agents grow skills — that's
  // the whole point of the feature. ("auto" marks a self-learned skill; builtins don't count.)
  const learned = Object.values(reg.skills).filter((s) => s.auto).length;
  const young = learned < 8;
  if (acts.length < (young ? 3 : 5)) return;
  if (!young && Date.now() - _lastSkillLearn < SKILL_COOLDOWN_MS) return;
  _lastSkillLearn = Date.now();
  const existing =
    Object.values(reg.skills)
      .map((s) => s.name)
      .join(", ") || "(none)";
  // ONE reflection call distills both: a reusable skill AND durable memory
  // facts (Hermes-style growth without doubling the token bill).
  const agentEntry = reg.agents && reg.agents[agent];
  const out = await claudeText(
    `An AI office agent "${agent}" just completed a task.\n` +
      `Task prompt: ${String(prompt).slice(0, 600)}\n` +
      `Tools used in order: ${acts.join(" -> ")}\n` +
      `Final report: ${String(finalText).slice(0, 800)}\n\n` +
      `Existing skills: ${existing}\n\n` +
      `Two reflections, output STRICT JSON only:\n` +
      `{"skill": {"name":"short-kebab-name","description":"one line",` +
      `"content":"imperative step-by-step instructions, max 12 lines"} | null,\n` +
      ` "memory": ["short durable fact about the OWNER/preferences ` +
      `worth remembering across conversations (Thai)", ...max 2] | null,\n` +
      (projId
        ? ` "projectMemory": ["short durable fact specific to THIS project ` +
          `worth remembering (Thai)", ...max 2] | null}\n`
        : ` "projectMemory": null}\n`) +
      `skill = null unless this contains a REUSABLE, GENERALIZABLE procedure ` +
      `not covered by an existing skill. memory/projectMemory = null unless ` +
      `genuinely worth remembering forever. Be strict; most tasks yield nulls.`,
    {
      provider: agentEntry && agentEntry.provider,
      model: agentEntry && agentEntry.model,
    },
  );
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return;
  try {
    const j = JSON.parse(m[0]);
    if (Array.isArray(j.memory)) memAppend(agent, j.memory.slice(0, 2));
    if (projId && Array.isArray(j.projectMemory))
      projMemAppend(projId, j.projectMemory.slice(0, 2));
    const sk = j.skill;
    if (!sk || !sk.name || !sk.content) return;
    const id = slugId(sk.name);
    if (reg.skills[id]) return;
    reg.skills[id] = {
      name: String(sk.name).slice(0, 60),
      description: String(sk.description || "").slice(0, 200),
      content: String(sk.content).slice(0, 4000),
      auto: true,
      by: agent,
    };
    const a = reg.agents[agent];
    if (a && !a.skills.includes(id)) a.skills.push(id);
    saveReg();
    pushRoster();
    if (retrievalOk)
      try {
        retrieval.reindexSkill(id, reg.skills[id]);
        retrieval.persist();
      } catch {}
    try {
      if (reg.nativeSkills !== false)
        skillsSync.syncAgent(
          AGENTS_DIR,
          agent,
          (reg.agents[agent] || {}).skills || [],
          reg.skills,
        );
    } catch {}
    broadcast({
      type: "skill.created",
      agent,
      task,
      skill: reg.skills[id].name,
    });
  } catch {}
}

// ---------------------------------------------------------------- sessions
// Named chat sessions per agent. Default behavior: every /chat continues
// the agent's latest session (continuous memory); "new" starts a thread;
// an explicit key resumes that thread and makes it the latest again.

const SESSIONS = path.join(__dirname, "sessions.json");
let sess = {};
try {
  sess = JSON.parse(fs.readFileSync(SESSIONS, "utf8"));
} catch {}
function saveSess() {
  fs.writeFileSync(SESSIONS, JSON.stringify(sess, null, 2));
}

// One-time boot housekeeping (P0): keep journal + sessions from growing forever
// on long-running offices. Both fail-open — any error leaves today's state intact.
try {
  const r = maintenance.rotateJournal(JOURNAL);
  if (r.rotated)
    console.log(`[maint] journal trimmed ${r.before} -> ${r.kept} lines`);
} catch (e) {
  console.error("[maint] journal:", e.message);
}
try {
  const p = maintenance.pruneSessions(sess);
  if (p.changed) {
    sess = p.sess;
    saveSess();
    console.log(`[maint] pruned ${p.dropped} stale session thread(s)`);
  }
} catch (e) {
  console.error("[maint] sessions:", e.message);
}
function latestSession(agent) {
  const l = sess[agent] || [];
  return l.length ? l.reduce((a, b) => (a.ts > b.ts ? a : b)) : null;
}

// The swappable brain: which backend an agent's `claude` spawn talks to. Returns
// env overrides (ANTHROPIC_BASE_URL/_AUTH_TOKEN) + --model args; "claude"/unset/
// unconfigured → empties, so the spawn is unchanged (fail-open). See providers.js.
// `override` (the opt-in failover brain) wins over the agent's own provider/model.
function brainRoute(agentId, override) {
  const a = agentId && reg.agents ? reg.agents[agentId] : null;
  const provider =
    (override && override.provider) ||
    (a && a.provider) ||
    reg.defaultProvider ||
    "claude";
  const model = (override && override.model) || (a && a.model) || "";
  return providers.resolve(provider, model, reg, {
    proxyBase: "http://127.0.0.1:" + OEP_PORT,
  });
}

// How many sustained api_retry hits (all 5xx) before the OPT-IN failover kicks in.
// The claude CLI itself retries ~10× over ~2 min; we cut in earlier so a dead brain
// doesn't burn the whole window before switching. 0 disables the early cut entirely.
const FAILOVER_AFTER = 3;

// OPT-IN office-wide emergency fallback brain. When the owner has set one
// (reg.fallbackProvider), an agent whose own brain is SUSTAINEDLY overloaded (repeated
// 5xx) is re-run on this brain instead of dying on the retry loop. Unset → null → the
// office behaves exactly as before (fail-open; the same brain just retries hard). Never
// falls back onto the same provider, and only onto one that's actually configured
// (Claude via login/plan, or a hosted key / local endpoint), so it can't route a task
// into a second dead brain.
function officeFallback(curProvider) {
  const p = reg.fallbackProvider;
  if (!p || p === curProvider) return null;
  if (p !== "claude") {
    const pc = (reg.providerConfig || {})[p];
    if (!pc || (!pc.token && !pc.baseUrl)) return null; // not connected / no credential
  }
  return { provider: p, model: reg.fallbackModel || "" };
}

// A failure that means "the request was too big for this backend" — either a real
// context-window overflow or a low rate/TPM ceiling. These never succeed on retry of
// the same request, so they're the trigger for auto-compact + fresh-thread recovery.
// Matches ONLY genuine "can never fit" failures — a context-window overflow or the
// proxy's "larger than your account ... can never fit" 400. Deliberately excludes
// transient rolling-window rate limits (those surface as a retryable 429 and claude
// just backs off) so recovery never churns on a temporary TPM blip.
const OVERFLOW_RE =
  /larger than your account|can never fit|context[_ ]?length|context_length_exceeded|maximum context|context window|prompt is too long|input is too long|string too long|reduce the (length|number)|too many tokens|exceeds the maximum (context|number of tokens|token)|max \d+\s*[kmg]?b|request too large.{0,40}smaller file|payload too large|request entity too large|content[- ]?too large/i;
function isOverflowError(t) {
  return !!t && OVERFLOW_RE.test(String(t));
}
// Token-overflow vs request-PAYLOAD-overflow: the patterns above also catch byte-size
// caps (Groq's "max 32MB / smaller file", HTTP 413 / payload-too-large) — distinct from
// a token *rate* limit (OpenAI's "Request too large ... Limit L, Requested N" on TPM,
// which must pause/resume, not compact). The payload patterns don't match that TPM text
// (no "max ..MB", no "smaller file", no "413"), so a 32MB rejection now triggers the
// same summarize-and-restart-on-a-fresh-thread recovery as a context overflow instead of
// surfacing a raw error — the fresh thread drops the image-heavy history that bloated it.

// A TEMPORARY ceiling that DOES clear with time — usage/rate/quota limits, 429s, an
// overloaded backend. Unlike overflow, retrying the SAME request later succeeds, so
// these pause the task for auto-resume once the window resets (NOT a hard failure).
// Guard against matching context-overflow text (handled separately above).
const RATELIMIT_RE =
  /rate limit|rate-limit|\b429\b|too many requests|usage limit|quota|limit reached|limit will reset|resets at|try again later|overloaded|capacity|temporarily unavailable|service unavailable|\b503\b|insufficient_quota|billing/i;
function isRateLimit(t) {
  const s = String(t || "");
  return !!s && RATELIMIT_RE.test(s) && !isOverflowError(s);
}

// Per-backend INPUT-token budget for ONE request — the trigger for Claude-Code-style
// proactive compaction. Set near each model's context window minus headroom for the
// system prompt + tool schemas the office always sends (~25k). 0 = never compact
// (let the model self-manage). Unknown/custom → providerConfig.contextBudget,
// else a safe default. Overridable per provider via providerConfig[p].contextBudget.
// Claude's window is ~1M, so a long resumed thread can grow huge (and bill huge per
// turn) before Claude self-compacts near the limit — cap it at 200k so the office
// proactively compacts long threads and keeps per-turn cost down. (Set 0 to revert.)
const CTX_BUDGET = {
  claude: 200000,
  glm: 160000,
  deepseek: 800000,
  qwen: 230000,
  minimax: 180000,
  moonshot: 210000,
  kimicode: 210000,
  openai: 115000,
  gemini: 800000,
  openrouter: 100000,
  nvidia: 100000,
};
function provBudget(agent) {
  const a = reg.agents && reg.agents[agent];
  const p = (a && a.provider) || reg.defaultProvider || "claude";
  const pc = (reg.providerConfig || {})[p] || {};
  const b = Number(pc.contextBudget);
  if (b > 0) return b; // explicit per-provider override wins
  if (p === "claude") return CTX_BUDGET.claude; // 0 = let Claude self-compact
  // Derive from the model's real window (live or researched) so the compaction point
  // tracks each model — leave ~20% headroom for the reply + office preamble overhead.
  const w = modelWindow(p, pc.model || (a && a.model));
  if (w > 0) return Math.round(w * 0.8);
  return p in CTX_BUDGET ? CTX_BUDGET[p] : 100000;
}
// Estimate a resumed thread's size from the REAL claude session file (full tool
// outputs live there, not in our trimmed log). bytes/4 ≈ tokens; + office overhead.
function overBudget(agent, entry, cwd) {
  const budget = provBudget(agent);
  if (!budget || !entry || !entry.sid) return false; // 0 = claude self-compacts
  try {
    const enc = String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
    const f = path.join(
      require("os").homedir(),
      ".claude",
      "projects",
      enc,
      entry.sid + ".jsonl",
    );
    const estTokens = Math.round(fs.statSync(f).size / 4) + 25000;
    return estTokens > budget;
  } catch {
    return false;
  }
}

// Context window per backend — the LAST-RESORT fallback when a model isn't known and
// the provider didn't advertise a length. Per-MODEL windows (MODEL_CTX / live) and the
// per-provider override (providerConfig.contextWindow) both take precedence.
// Claude defaults to 1M because the current generation (Opus 4.8 / Sonnet 4.6) ships a
// 1M-token window as standard; an agent on the BLANK default model lands here. The only
// 200k Claude is Haiku 4.5, which is caught explicitly in MODEL_CTX when chosen.
const CTX_WINDOW = {
  claude: 1000000,
  glm: 200000,
  deepseek: 1000000,
  qwen: 256000,
  minimax: 200000,
  moonshot: 262144,
  kimicode: 262144,
  openai: 128000,
  gemini: 1000000,
  openrouter: 128000,
  nvidia: 128000,
};

// Per-MODEL context windows (input tokens), researched against each provider's docs.
// A live value captured from the provider's /models endpoint (modelCtx) wins over this,
// and providerConfig[p].contextWindow overrides everything. Matched: exact id → vendor-
// stripped id → family substring. Keep ids lowercase except where the API is case-exact.
const MODEL_CTX = {
  // Claude — 1M is standard on the 4.6/4.8 generation; Haiku stays 200k.
  "claude-opus-4-8": 1000000,
  "claude-sonnet-4-6": 1000000,
  "claude-haiku-4-5": 200000,
  opus: 1000000,
  sonnet: 1000000,
  haiku: 200000,
  // DeepSeek — v4-pro / v4-flash both 1M (output up to 384k).
  "deepseek-v4-pro": 1000000,
  "deepseek-v4-flash": 1000000,
  // Gemini 2.5 — ~1,048,576 (no 2M on the 2.5 series; that was 1.5 Pro).
  "gemini-2.5-pro": 1048576,
  "gemini-2.5-flash": 1048576,
  // GLM (Z.AI) — GLM-5.2 ships a real 1M window, but ONLY via the "glm-5.2[1m]" model
  // id; plain "glm-5.2" serves the ~200k default. Map both so the meter + compaction
  // budget are accurate either way, and the owner can opt into 1M by picking [1m].
  "glm-5.2[1m]": 1000000,
  "glm-5.2": 200000,
  "glm-4.6": 200000,
  "glm-4.5": 128000,
  // Qwen3-Coder — plus/flash serve 1M via the API; the open "next" build is 256k.
  "qwen3-coder-plus": 1048576,
  "qwen3-coder-flash": 1048576,
  "qwen3-coder-next": 262144,
  // MiniMax (key stored lowercase — modelWindow lowercases before lookup).
  "minimax-m3": 1000000,
  "minimax-m2": 204800,
  // Kimi / Moonshot — current K2 series all serve 256k; the Kimi Code plan's
  // kimi-for-coding is 256k too (its docs set CLAUDE_CODE_AUTO_COMPACT_WINDOW=262144).
  "kimi-k2.6": 262144,
  "kimi-k2.5": 262144,
  "kimi-k2": 262144,
  "kimi-latest": 262144,
  "kimi-for-coding": 262144,
  // OpenAI — 4o family 128k; the 4.1 family ~1M; o-series reasoning 200k.
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4.1": 1047576,
  "gpt-4.1-mini": 1047576,
  "gpt-4.1-nano": 1047576,
  o3: 200000,
  "o4-mini": 200000,
  // xAI Grok — 3 = 131k, 4 = 256k, 4.3 = 1M (legacy slugs now redirect to 4.3).
  "grok-3": 131072,
  "grok-3-mini": 131072,
  "grok-4": 256000,
  "grok-4.3": 1000000,
  // Mistral — Large 3 (2512) 256k; Codestral 25.08 256k, older 128k.
  "mistral-large-latest": 256000,
  "mistral-large-2512": 256000,
  "codestral-latest": 128000,
  "codestral-2508": 256000,
  // Common open-weight models on the inference hosts (live values override these).
  "deepseek-v3": 131072,
  "deepseek-r1": 131072,
  "qwen2.5-coder": 32768,
};
// Family fallbacks — matched by substring when an exact id isn't listed. Ordered
// most-specific first (e.g. grok-4.3 before grok-4 before grok). Live + exact win.
const MODEL_CTX_FAMILY = [
  ["gemini-2.5", 1048576],
  ["gemini-1.5-pro", 2097152],
  ["gemini-1.5", 1048576],
  ["deepseek-v4", 1000000],
  ["deepseek-v3", 131072],
  ["deepseek-r1", 131072],
  ["claude-opus-4", 1000000],
  ["claude-sonnet-4", 1000000],
  ["claude-haiku", 200000],
  ["glm-5.2[1m]", 1000000],
  ["glm-5.2", 200000],
  ["glm-5", 200000],
  ["glm-4.6", 200000],
  ["glm-4.5", 128000],
  ["glm-4", 128000],
  ["qwen3-coder-plus", 1048576],
  ["qwen3-coder-flash", 1048576],
  ["qwen3-coder", 262144],
  ["qwen3-next", 262144],
  ["qwen3", 262144],
  ["qwen2.5-coder", 32768],
  ["minimax-m3", 1000000],
  ["minimax", 204800],
  ["kimi", 262144],
  ["gpt-4.1", 1047576],
  ["gpt-4o", 128000],
  ["o4-mini", 200000],
  ["grok-4.3", 1000000],
  ["grok-4", 256000],
  ["grok-3", 131072],
  ["grok", 131072],
  ["mistral-large", 256000],
  ["codestral", 128000],
  ["mistral", 128000],
  ["llama-3.3", 131072],
  ["llama-3.1", 131072],
  ["llama3.1", 131072],
  ["llama-4", 1000000],
  ["llama", 131072],
];
// Resolve a model's context window (tokens) or null if unknown.
function modelWindow(provider, model) {
  const raw = String(model || "");
  if (!raw) return null;
  const live = ((reg.providerConfig || {})[provider] || {}).modelCtx || {};
  if (Number(live[raw]) > 0) return Number(live[raw]);
  const id = raw.toLowerCase();
  const norm = id.replace(/^[a-z0-9_.-]+\//, ""); // drop "openai/", "deepseek-ai/", …
  if (Number(live[norm]) > 0) return Number(live[norm]);
  if (MODEL_CTX[id]) return MODEL_CTX[id];
  if (MODEL_CTX[norm]) return MODEL_CTX[norm];
  for (const [sub, w] of MODEL_CTX_FAMILY)
    if (id.includes(sub) || norm.includes(sub)) return w;
  return null;
}
// Pull a model's context length from a /models list entry (field name varies by API:
// OpenRouter context_length / top_provider.context_length, vLLM max_model_len, etc.).
function ctxFromModelObj(m) {
  if (!m || typeof m !== "object") return 0;
  return (
    Number(
      m.context_length ||
        m.context_window ||
        m.max_context_length ||
        m.max_model_len ||
        (m.top_provider && m.top_provider.context_length) ||
        0,
    ) || 0
  );
}
// Capture live per-model context windows from a provider's /models response, so the
// usage meter + compaction budget self-tune to what the provider actually serves.
function captureModelCtx(provider, data) {
  try {
    const map = {};
    for (const m of data || []) {
      const c = ctxFromModelObj(m);
      if (m && m.id && c > 0) map[String(m.id)] = c;
    }
    if (!Object.keys(map).length) return;
    reg.providerConfig = reg.providerConfig || {};
    reg.providerConfig[provider] = reg.providerConfig[provider] || {};
    reg.providerConfig[provider].modelCtx = map;
    saveReg();
  } catch {}
}
function ctxWindow(agent) {
  const a = reg.agents && reg.agents[agent];
  const p = (a && a.provider) || reg.defaultProvider || "claude";
  const pc = (reg.providerConfig || {})[p] || {};
  if (Number(pc.contextWindow) > 0) return Number(pc.contextWindow);
  const w = modelWindow(p, pc.model || (a && a.model));
  return w > 0 ? w : CTX_WINDOW[p] || 128000;
}
// Short "provider/model" tag shown in the chat history (which brain produced a line).
function modelTag(agent) {
  const a = (reg.agents && reg.agents[agent]) || {};
  const p = a.provider || reg.defaultProvider || "claude";
  if (p === "claude") return a.model ? "claude/" + a.model : "claude";
  return a.model ? p + "/" + a.model : p;
}

// Plain headless claude call → final text (prompt drafting, reflections).
// opts.provider/opts.model route this one-shot to a non-Claude backend too.
function claudeText(prompt, opts = {}) {
  return new Promise((resolve) => {
    // opts.tools: a comma string of allowed tools. With it, the meeting agent
    // can look real things up (WebSearch/WebFetch/Read…). The broker settings
    // ride along so anything OUTSIDE the allowed set still asks the owner to
    // allow — same flow as a real task, just only when genuinely needed.
    const args = ["-p"];
    if (opts.tools) {
      args.push(
        "--allowedTools",
        opts.tools,
        "--settings",
        path.join(WORKSPACE, ".claude", "settings.json"),
      );
    }
    const route = providers.resolve(opts.provider, opts.model, reg);
    if (route.modelArgs.length) args.push(...route.modelArgs);
    const child = spawn("claude", args, {
      cwd: WORKSPACE,
      shell: true,
      env: {
        ...process.env,
        ...(reg.apiKeys || {}),
        ...route.env,
        OFFICE_ADAPTER: "1",
        ...(opts.env || {}),
      },
    });
    child.stdin.write(prompt);
    child.stdin.end();
    let out = "";
    child.stdout.setEncoding("utf8"); // multibyte-safe across chunk boundaries (Thai etc.)
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(""));
  });
}

// ---------------------------------------------------------------- websocket

function wsAccept(key) {
  return crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}

// Server→client text frame (we never need to parse client frames).
function wsFrame(str) {
  const b = Buffer.from(str, "utf8");
  let head;
  if (b.length < 126) head = Buffer.from([0x81, b.length]);
  else if (b.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(b.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(b.length), 2);
  }
  return Buffer.concat([head, b]);
}

function journalTail(n) {
  try {
    const lines = fs.readFileSync(JOURNAL, "utf8").trim().split("\n");
    return lines.slice(-n);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- bus

function broadcast(evt, journal = true) {
  evt.ts = Date.now();
  const json = JSON.stringify(evt);
  if (journal) fs.appendFile(JOURNAL, json + "\n", () => {});
  const frame = wsFrame(json);
  for (const s of wsClients) s.write(frame);
  if (evt.type !== "world.pos") console.log("[oep] →", json);
}

// ---------------------------------------------------------------- office ops
// Standing work orders (jobs), the shared note board, and the calendar —
// plus the Director's heartbeat. One 30-second scheduler ticks everything.

const JOBS = path.join(__dirname, "jobs.json");
const NOTES = path.join(__dirname, "notes.json");
const CAL = path.join(__dirname, "calendar.json");
const NOTES_MD = path.join(WORKSPACE, "notes.md");

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
// ---- 🧠 office memory (Hermes-style, token-lean) --------------------------
// Two layers, both PLAIN FILES the agents can read and grep themselves:
//   workspace/OFFICE.md        — shared knowledge about the owner/org
//   workspace/memory/<id>.md   — what each agent has learned, one bullet
//                                per fact, auto-distilled after real work
// Injection stays TINY: fresh sessions get only the last few bullets plus
// pointers — full recall is on-demand (Read/Grep), never preloaded.
const OFFICE_MD = path.join(WORKSPACE, "OFFICE.md");
const MEM_DIR = path.join(WORKSPACE, "memory");
fs.mkdirSync(MEM_DIR, { recursive: true });
const OFFICE_MD_DEFAULT =
  "# OFFICE.md — shared office knowledge\n\n" +
  "(The owner can edit this from the 🗂 NOTES tab. Every agent knows where this " +
  "file is and reads it only when it's relevant to the work. Write in any language.)\n\n" +
  "## About the owner\n- \n\n## Office rules\n- \n";
// English by default (this is a global product); agents may append in any
// language later. Also migrate the OLD Thai default in place: it's a single
// shared file regardless of UI language, so when it's still the untouched
// Thai template we replace it with the English one (never clobber real content).
const OFFICE_MD_OLD_TH =
  "# OFFICE.md — ข้อมูลกลางของออฟฟิศ\n\n" +
  "(เจ้าของแก้ไฟล์นี้ได้จากหน้า 🗂 NOTES — agents ทุกตัวรู้ว่าไฟล์นี้อยู่ที่ไหน " +
  "และจะเปิดอ่านเมื่อเกี่ยวข้องกับงานเท่านั้น)\n\n" +
  "## เกี่ยวกับเจ้าของ\n- \n\n## กฎของออฟฟิศ\n- \n";
if (!fs.existsSync(OFFICE_MD)) {
  fs.writeFileSync(OFFICE_MD, OFFICE_MD_DEFAULT);
} else {
  try {
    if (fs.readFileSync(OFFICE_MD, "utf8").trim() === OFFICE_MD_OLD_TH.trim())
      fs.writeFileSync(OFFICE_MD, OFFICE_MD_DEFAULT);
  } catch {}
}
// Migrate: an older OFFICE.md told agents to copy media into workspace/uploads
// ("the chat renderer only sees files in workspace") — that's been false since the
// chat renders media from ANY path. If the stale line is present, fix it in place.
try {
  let md = fs.readFileSync(OFFICE_MD, "utf8");
  if (
    /มองเห็นเฉพาะไฟล์ใน workspace|copy เข้า `workspace\/uploads\/` ก่อนเสมอ/.test(
      md,
    )
  ) {
    md = md.replace(
      /^- \*\*ส่งไฟล์ให้ CEO ในแชท[^\n]*$/m,
      "- **ส่งไฟล์ให้ CEO ในแชท (รูป/วิดีโอ/เสียง)**: แปะ full path ของไฟล์ในบรรทัดของมันเอง — ไฟล์อยู่ที่ไหนก็ได้บนเครื่อง (Desktop, Downloads, ไดรฟ์อื่น, โปรเจค, workspace ฯลฯ) ออฟฟิศ render ในแชทได้หมด **ไม่ต้อง copy เข้า workspace ก่อน** — ห้ามบอกแค่ที่อยู่หรือแปะลิงก์ดาวน์โหลด ให้ส่ง path ตรงๆ แล้วแชทจะแสดงให้เอง",
    );
    fs.writeFileSync(OFFICE_MD, md);
  }
} catch {}

// 🔀 One-time cleanup: older versions SEEDED example workflows into
// workspace/workflows. Examples now live read-only in the bundle, so drop any
// stale workspace copies (id starts with "example-") to avoid duplicates. The
// user's own workflows (wf_* ids) are left untouched.
(function dropSeededExamples() {
  try {
    const dir = path.join(WORKSPACE, "workflows");
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const w = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (String(w.id || "").startsWith("example-"))
          fs.unlinkSync(path.join(dir, f));
      } catch {}
    }
  } catch {}
})();

// 🧹 Retire the short-lived "custom character" experiment: any agent left on
// avatar 0 (or with leftover tint colors) is moved back to a normal NPC sheet so
// it renders properly. One-time, idempotent.
(function dropCustomAvatars() {
  let changed = false;
  for (const id of Object.keys(reg.agents || {})) {
    const a = reg.agents[id];
    if (!a) continue;
    if (!(a.avatar >= 1 && a.avatar <= 12)) {
      let h = 0;
      for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
      a.avatar = (Math.abs(h) % 12) + 1;
      changed = true;
    }
    if (a.skin || a.hair || a.suit) {
      delete a.skin;
      delete a.hair;
      delete a.suit;
      changed = true;
    }
  }
  if (changed)
    try {
      saveReg();
    } catch {}
})();

// 🌐 Ship pre-translated UI caches: merge daemon/i18n-seed/<lang>.json into the
// runtime cache (daemon/i18n/) on startup, so the UI shows in the chosen
// language even with NO Gemini key. Runtime entries win (they may be newer or
// hand-edited); the bundled seed only fills the gaps.
(function seedI18n() {
  try {
    const seedDir = path.join(__dirname, "i18n-seed");
    const runDir = path.join(__dirname, "i18n");
    if (!fs.existsSync(seedDir)) return;
    fs.mkdirSync(runDir, { recursive: true });
    for (const f of fs.readdirSync(seedDir)) {
      if (!f.endsWith(".json")) continue;
      let seed = {},
        run = {};
      try {
        seed = JSON.parse(fs.readFileSync(path.join(seedDir, f), "utf8"));
      } catch {}
      try {
        run = JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8"));
      } catch {}
      const out = path.join(runDir, f),
        tmp = out + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ ...seed, ...run }));
      fs.renameSync(tmp, out); // atomic — never leaves a half-written cache
    }
  } catch {}
})();

function memFile(agent) {
  return path.join(MEM_DIR, String(agent).replace(/[^\w-]/g, "_") + ".md");
}
function memTail(agent, n) {
  try {
    const lines = fs
      .readFileSync(memFile(agent), "utf8")
      .split("\n")
      .filter((l) => l.trim().startsWith("- "));
    return lines.slice(-n);
  } catch {
    return [];
  }
}
function memAppend(agent, facts) {
  if (!facts || !facts.length) return;
  const file = memFile(agent);
  let cur = "";
  try {
    cur = fs.readFileSync(file, "utf8");
  } catch {}
  const fresh = facts
    .map((f) => String(f).replace(/\s+/g, " ").trim().slice(0, 200))
    .filter((f) => f && !cur.includes(f));
  if (!fresh.length) return;
  if (!cur) cur = `# ${agent}のメモリ\n\n`;
  fs.appendFileSync(file, fresh.map((f) => `- ${f}`).join("\n") + "\n");
  // Keep the retrieval index in step with the new facts (no-op until P1 init).
  try {
    if (retrievalOk) {
      retrieval.reindexFile("mem", path.basename(file, ".md"), file);
      retrieval.persist();
    }
  } catch {}
  broadcast({ type: "memory.learned", agent, count: fresh.length }, false);
}

// ---- retrieval index (P1) -------------------------------------------------
// Relevance lookup over memory / project / owner / skill / meeting-archive, so
// agents can recall only what's relevant instead of dumping everything. Built
// from the office's own files on boot; fail-open (retrievalOk stays false on
// any error and every consumer falls back to today's behavior).
let retrievalOk = false;
const RETRIEVAL_INDEX = path.join(WORKSPACE, "index", "retrieval.json");
try {
  retrieval.init({
    indexFile: RETRIEVAL_INDEX,
    memDir: MEM_DIR,
    officeMd: OFFICE_MD,
    projectsDir: path.join(WORKSPACE, "projects"),
    meetingsDir: path.join(WORKSPACE, "meetings"),
    skills: reg.skills,
  });
  retrievalOk = true;
  console.log("[retrieval]", JSON.stringify(retrieval.stats()));
} catch (e) {
  console.error("[retrieval] init:", e.message);
}
// Self-heal when the owner edits OFFICE.md outside the daemon.
try {
  fs.watchFile(OFFICE_MD, { interval: 5000 }, () => {
    if (!retrievalOk) return;
    try {
      retrieval.reindexFile("user", "OFFICE", OFFICE_MD);
      retrieval.persist();
    } catch {}
  });
} catch {}

// ---- native skills (P3) ---------------------------------------------------
// Each agent's assigned skills are projected to workspace/agents/<id>/.claude/
// skills/*/SKILL.md and exposed to its sessions via --add-dir, so skill bodies
// disclose on demand instead of bloating every preamble. Flag-reversible:
// set reg.nativeSkills = false to fall back to inline injection.
const AGENTS_DIR = path.join(WORKSPACE, "agents");
try {
  if (reg.nativeSkills !== false) {
    const s = skillsSync.syncAll(AGENTS_DIR, reg.agents, reg.skills);
    console.log(`[skills] native sync: wrote ${s.wrote}, pruned ${s.pruned}`);
  }
} catch (e) {
  console.error("[skills] boot sync:", e.message);
}
// The note every fresh session carries — pointers + a short tail, never the
// whole archive.
// Per-project memory (office-owned — NEVER written into the user's repo).
function projMemFile(projId) {
  return path.join(
    WORKSPACE,
    "projects",
    String(projId).replace(/[^\w-]/g, "_"),
    "MEMORY.md",
  );
}
function projMemAppend(projId, facts) {
  if (!projId || !facts || !facts.length) return;
  const file = projMemFile(projId);
  let cur = "";
  try {
    cur = fs.readFileSync(file, "utf8");
  } catch {}
  const fresh = facts
    .map((f) => String(f).replace(/\s+/g, " ").trim().slice(0, 200))
    .filter((f) => f && !cur.includes(f));
  if (!fresh.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!cur) fs.writeFileSync(file, `# Project memory: ${projId}\n\n`);
  fs.appendFileSync(file, fresh.map((f) => `- ${f}`).join("\n") + "\n");
  try {
    if (retrievalOk) {
      retrieval.reindexFile("proj", path.basename(path.dirname(file)), file);
      retrieval.persist();
    }
  } catch {}
}

// Strip prompt scaffolding (xml-ish tags, DELEGATE/PROJECT/SUB protocol words)
// so the retrieval query reflects the actual task, not the wrapper.
function cleanForQuery(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\b(DELEGATE|PROJECT|SUB|SPEAK|PROPOSAL)\s*:/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

// The Hermes step: inject the memory that's RELEVANT to this task (top-K across
// the agent's own memory, this project's memory, and owner facts) instead of
// dumping the last 8 bullets. Pointers stay so full recall is one Read/​/recall
// away. Fail-open: no index / flag off / no match → exactly the old last-8 dump.
function memoryNote(agent, taskText, projId) {
  const memRef = path.basename(memFile(agent), ".md");
  const header =
    `\n<office-memory>\n` +
    `オフィスの共有情報：workspace/OFFICE.md（業務に関係するときだけ開いて読む）\n` +
    `あなたの永続メモリ帳：workspace/memory/${memRef}.md ` +
    `— 会話をまたいで覚えておくべきオーナー/業務に関する重要な事実を見つけたら、自分で短く "- ..." の行を追記すること\n` +
    (projId
      ? `このプロジェクトのメモリ：${projMemFile(projId).replace(WORKSPACE + path.sep, "")}\n`
      : "") +
    `過去のメモリはすべて GET /recall?q=<検索語> で検索できる（skill: archive-search）\n`;
  let recall = "";
  const q = cleanForQuery(taskText);
  if (retrievalOk && reg.retrieval !== false && q) {
    try {
      const tiers = projId ? ["mem", "proj", "user"] : ["mem", "user"];
      const refs = { mem: memRef, user: true };
      if (projId) refs.proj = projId;
      const hits = retrieval.search(q, {
        tiers,
        refs,
        k: 6,
        boost: { proj: 1.3, mem: 1.2, user: 1.0 },
      });
      const lines = [];
      let used = 0;
      for (const h of hits) {
        const t = h.text.replace(/\s+/g, " ").trim();
        if (used + t.length > 1500) break;
        lines.push(`- ${t}`);
        used += t.length;
      }
      if (lines.length)
        recall = `この業務に関係するメモリ：\n${lines.join("\n")}\n`;
    } catch {
      /* fall through to the tail */
    }
  }
  if (!recall) {
    const tail = memTail(agent, 8);
    if (tail.length) recall = `あなたの最新のメモリ：\n${tail.join("\n")}\n`;
  }
  return header + recall + `</office-memory>\n`;
}

// ---- 📊 office stats: per-day run counts + spend, for the dashboard.
const STATS = path.join(__dirname, "stats.json");
let stats = loadJson(STATS, {});
function statBump(field, agent, cost) {
  const day = new Date().toISOString().slice(0, 10);
  const d = (stats[day] = stats[day] || {
    runs: 0,
    done: 0,
    failed: 0,
    cost: 0,
    agents: {},
  });
  if (field) d[field] = (d[field] || 0) + 1;
  if (agent && field === "runs") d.agents[agent] = (d.agents[agent] || 0) + 1;
  if (cost) d.cost = Math.round((d.cost + cost) * 10000) / 10000;
  clearTimeout(statBump._t);
  statBump._t = setTimeout(
    () => fs.writeFile(STATS, JSON.stringify(stats, null, 1), () => {}),
    1500,
  );
}

// Rough per-use cost ESTIMATES for the secondary tools (USD). Unlike Claude,
// these APIs don't return a real cost, so the dashboard labels them "≈". Tune
// freely — public pricing moves. (One place to edit.)
const COST_RATES = {
  gemini_tts_per_char: 0.000016, // Gemini 2.5 Flash TTS, per input char
  gemini_image_each: 0.039, // Gemini 2.5 Flash image, per image
  gemini_i18n_per_char: 0.0000004, // flash-latest translate, per char (tiny)
  gemini_transcribe_each: 0.002, // Gemini STT fallback, per clip (~30s)
  openai_whisper_each: 0.003, // OpenAI Whisper, per clip (~30s @ $0.006/min)
  openai_image_each: 0.04, // OpenAI image, per image
};
// Add an ESTIMATED secondary-tool spend under stats[day].aux[provider].
function auxCost(provider, usd) {
  if (!usd || usd <= 0) return;
  const day = new Date().toISOString().slice(0, 10);
  const d = (stats[day] = stats[day] || {
    runs: 0,
    done: 0,
    failed: 0,
    cost: 0,
    agents: {},
  });
  d.aux = d.aux || { gemini: 0, openai: 0 };
  d.aux[provider] = Math.round(((d.aux[provider] || 0) + usd) * 1e6) / 1e6;
  clearTimeout(statBump._t);
  statBump._t = setTimeout(
    () => fs.writeFile(STATS, JSON.stringify(stats, null, 1), () => {}),
    1500,
  );
}

// Swapped-in brains don't return a real bill, so estimate from token usage. Rough
// public $/1M [input, output]; tune freely. (openrouter/nvidia vary by model — rough.)
const BRAIN_PRICES = {
  glm: [0.6, 2.2],
  deepseek: [0.28, 1.1],
  qwen: [0.4, 1.2],
  minimax: [0.3, 1.2],
  openai: [2.5, 10],
  gemini: [0.15, 0.6],
  openrouter: [1, 3],
  nvidia: [0, 0],
};
// Accumulate a swapped-in brain's token spend under stats[day].brains[provider].
function brainBump(provider, inTok, outTok) {
  if (!provider || provider === "claude") return;
  const day = new Date().toISOString().slice(0, 10);
  const d = (stats[day] = stats[day] || {
    runs: 0,
    done: 0,
    failed: 0,
    cost: 0,
    agents: {},
  });
  d.brains = d.brains || {};
  const b = (d.brains[provider] = d.brains[provider] || {
    in: 0,
    out: 0,
    cost: 0,
    runs: 0,
  });
  b.in += inTok || 0;
  b.out += outTok || 0;
  b.runs += 1;
  const pr = BRAIN_PRICES[provider] || [0, 0];
  b.cost =
    Math.round(
      (b.cost + ((inTok || 0) / 1e6) * pr[0] + ((outTok || 0) / 1e6) * pr[1]) *
        1e6,
    ) / 1e6;
  clearTimeout(statBump._t);
  statBump._t = setTimeout(
    () => fs.writeFile(STATS, JSON.stringify(stats, null, 1), () => {}),
    1500,
  );
}

let jobs = loadJson(JOBS, []); // {id, agent, prompt, mode, at, time, daily, everyMin, enabled, lastRun, lastDay, done, sessionKey, running}
let notes = loadJson(NOTES, []); // {id, who, text, ts}
let cal = loadJson(CAL, []); // {id, title, at, remindMin, notified}
// Clean up one-shot jobs that already fired (no `running` survives a restart) —
// run-now or one-time scheduled orders have nothing left to do, so they should
// not linger as dead, uneditable rows.
{
  const _n = jobs.length;
  jobs = jobs
    .filter((j) => {
      const oneShot = j.mode === "now" || (j.mode === "at" && !j.daily);
      return !(oneShot && (j.lastRun || j.done));
    })
    .map((j) => {
      delete j.running;
      return j;
    });
  if (jobs.length !== _n) fs.writeFileSync(JOBS, JSON.stringify(jobs, null, 2));
}
const saveJobs = () => fs.writeFileSync(JOBS, JSON.stringify(jobs, null, 2));
const saveCal = () => fs.writeFileSync(CAL, JSON.stringify(cal, null, 2));

// The note board lives twice: notes.json for the UI, notes.md inside the
// agents' workspace so they can READ it and APPEND bullets themselves.
let writingNotesMd = false;
function saveNotes() {
  fs.writeFileSync(NOTES, JSON.stringify(notes, null, 2));
  writingNotesMd = true;
  const md =
    "# Office Notes — 共有メモボード\n" +
    '(agents: 読み取り可能。"- メッセージ" の行を追記すれば CEO へメモを残せます)\n\n' +
    notes.map((n) => `- ${n.text}`).join("\n") +
    "\n";
  fs.writeFileSync(NOTES_MD, md);
  setTimeout(() => {
    writingNotesMd = false;
  }, 1500);
  broadcast({ type: "notes.changed", count: notes.length }, false);
}
if (!fs.existsSync(NOTES_MD)) saveNotes();
fs.watchFile(NOTES_MD, { interval: 3000 }, () => {
  if (writingNotesMd) return;
  // An agent edited the board: bullet lines become the new truth.
  try {
    const lines = fs
      .readFileSync(NOTES_MD, "utf8")
      .split("\n")
      .map((l) => l.match(/^\s*[-*]\s+(.+)$/))
      .filter(Boolean)
      .map((m) => m[1].trim());
    notes = lines.map((text) => {
      const old = notes.find((n) => n.text === text);
      return (
        old || {
          id: "n" + Date.now() + Math.floor(Math.random() * 999),
          who: "agent",
          text,
          ts: Date.now(),
        }
      );
    });
    fs.writeFileSync(NOTES, JSON.stringify(notes, null, 2));
    broadcast({ type: "notes.changed", count: notes.length, by: "agent" });
  } catch {}
});

// ---- 📁 projects: real workspaces agents (and you) actually work in.
// A project = name + directory. Agents run with cwd there when a thread is
// bound to it; you can pop a terminal (claude -c) in it yourself, and the
// daemon detects whether that window is still open via a marker the
// launcher bakes into the process command line.

const PROJECTS_FILE = path.join(__dirname, "projects.json");
let projects = loadJson(PROJECTS_FILE, []); // {id, name, dir, ts, created}
// Migration: entries from before the `created` flag all came from the
// create flow (browse-registering didn't exist yet) — they're ours.
let migrated = false;
for (const p of projects)
  if (p.created === undefined) {
    p.created = true;
    migrated = true;
  }
const saveProjects = () =>
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
if (migrated) saveProjects();
let projWin = {}; // project id -> visible (true) / hidden (false)
const projRuns = {}; // project id -> active AI run count
const projAgents = {}; // project id -> {agentId: run count} (who's working)
const projChildren = {}; // project id -> Set<ChildProcess> (so the owner can stop the work and take over)
const runChildren = new Map(); // task id -> { child, agent } — cancel a running task mid-flight
function agentRunning(agent) {
  for (const v of runChildren.values()) if (v.agent === agent) return true;
  return false;
}

// ⏸ Paused work — tasks interrupted by a TEMPORARY limit (rate/usage/overload) or by a
// daemon restart, kept so the office RESUMES them instead of silently dropping the work.
// Keyed by the agent's thread key (one paused entry per thread). Persisted so a restart
// can pick up where it left off. Entry: { agent, prompt, project, key, ts, tries, state }
// state: "active" = running right now (so a restart knows it was mid-task) · "paused" =
// waiting for the cooldown to elapse, then auto-resumed on its own --resume thread.
const PAUSED_FILE = path.join(__dirname, "paused.json");
let pausedWork = loadJson(PAUSED_FILE, []);
let _pausedTimer = null;
function savePaused() {
  if (_pausedTimer) return;
  _pausedTimer = setTimeout(() => {
    _pausedTimer = null;
    try {
      fs.writeFileSync(PAUSED_FILE, JSON.stringify(pausedWork));
    } catch {}
  }, 400);
}
function pauseFind(key) {
  return pausedWork.find((w) => w.key === key);
}
function pauseClear(key) {
  const n = pausedWork.length;
  pausedWork = pausedWork.filter((w) => w.key !== key);
  if (pausedWork.length !== n) savePaused();
}
// Mark a resumable task as ACTIVE (running now). Survives a restart as "was mid-task".
function pauseActive(agent, prompt, project, key, tries) {
  if (!key) return;
  const w = pauseFind(key);
  if (w) {
    w.state = "active";
    w.agent = agent;
    w.prompt = prompt;
    w.project = project;
    w.tries = tries || 0;
  } else
    pausedWork.push({
      agent,
      prompt,
      project,
      key,
      ts: Date.now(),
      tries: tries || 0,
      state: "active",
    });
  savePaused();
}
// A temporary limit hit the task → leave it PAUSED for the resume tick (with backoff).
function pausePause(agent, prompt, project, key) {
  if (!key) return;
  const w = pauseFind(key);
  if (w) {
    w.state = "paused";
    w.ts = Date.now();
  } else
    pausedWork.push({
      agent,
      prompt,
      project,
      key,
      ts: Date.now(),
      tries: 0,
      state: "paused",
    });
  savePaused();
}
// Boot: anything left "active" was killed mid-task by the restart — treat it as paused
// so the resume tick continues it. (Clear stuck-active for the CEO/non-agents defensively.)
(function reclaimPausedOnBoot() {
  let changed = false;
  for (const w of pausedWork)
    if (w.state === "active") {
      w.state = "paused";
      w.ts = 0;
      changed = true;
    }
  if (changed) savePaused();
})();
const WINPROJ = path.join(__dirname, "winproj.ps1");
const MACPROJ = path.join(__dirname, "macproj.sh");
const LIVEVIEW = path.join(__dirname, "liveview.ps1");

// Cheap cached probe for `zenity` on PATH. Only meaningful on Linux; used by
// the /platform endpoint's nativePick hint. Synchronous so the endpoint can
// stay a plain JSON write — the result is memoized after the first call.
let _zenityCache = null;
function canZenity() {
  if (process.platform !== "linux") return false;
  if (_zenityCache !== null) return _zenityCache;
  try {
    // `command -v` is POSIX and always available in sh; throws when zenity
    // is not on PATH — that's the "not installed" case.
    require("child_process").execFileSync("sh", ["-c", "command -v zenity"], {
      stdio: "ignore",
    });
    _zenityCache = true;
  } catch {
    _zenityCache = false;
  }
  return _zenityCache;
}

function winproj(action, id, cb) {
  // Cross-platform project-window show/hide/stop/sweep.
  // Windows: PowerShell helper (winproj.ps1) walks the win32 window tree.
  // macOS:   AppleScript helper (macproj.sh) walks Terminal.app tabs.
  // Linux:   no window tracking (projects open in user's terminal of choice).
  if (process.platform === "win32") {
    const { execFile } = require("child_process");
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        WINPROJ,
        action,
        String(id || ""),
      ],
      { timeout: 20000, windowsHide: true },
      (e, out) => cb && cb(e, out),
    );
  } else if (process.platform === "darwin") {
    const { execFile } = require("child_process");
    execFile(
      "/bin/bash",
      [MACPROJ, action, String(id || "")],
      { timeout: 20000 },
      (e, out) => cb && cb(e, out),
    );
  } else if (wslx.isWSL()) {
    // Hybrid: project windows are Windows Terminal windows (opened via
    // interop in /projects/open) — drive the SAME winproj.ps1 through
    // powershell.exe. The script rides its \\wsl.localhost UNC path, which
    // -File + ExecutionPolicy Bypass runs fine.
    const win = wslx.toWinPath(WINPROJ);
    if (!win) {
      if (cb) cb(null, "");
      return;
    }
    wslx.psExec(
      ["-File", win, action, String(id || "")],
      { timeout: 20000 },
      (e, out) => cb && cb(e, out),
    );
  } else {
    if (cb) cb(null, "");
  }
}

function projectDir(id) {
  const p = projects.find((x) => x.id === id);
  return p ? p.dir : null;
}

// Headless claude in an untrusted folder stalls on the trust dialog it can
// never show. Pre-trust project dirs in ~/.claude.json (same flag the
// interactive "Yes, I trust this folder" sets).
function ensureTrusted(dir) {
  try {
    const file = path.join(require("os").homedir(), ".claude.json");
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    j.projects = j.projects || {};
    const key = String(dir).replace(/\\/g, "/").replace(/\/+$/, "");
    const cur = j.projects[key] || {};
    if (cur.hasTrustDialogAccepted === true) return;
    j.projects[key] = { ...cur, hasTrustDialogAccepted: true };
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    console.log("[proj] pre-trusted", key);
  } catch (e) {
    console.error("[proj] trust", e.message);
  }
}

// Mentioning a registered project by name in chat binds the thread to it:
// the agent runs INSIDE that directory and the project lights up 🤖.
// Matching is forgiving: case- and space-insensitive.
function projectFromPrompt(prompt) {
  // Auto-route into a project only when its name appears clearly in the task —
  // and don't get dragged in by a coincidental substring (e.g. a task "build a
  // web scraper" must NOT enter a project named "web"). For Latin/ASCII names we
  // require a WHOLE-WORD match; Thai/CJK has no word boundaries, so we fall back
  // to a squashed substring there. Min length 4, and only when EXACTLY one
  // project matches. Deliberate routing uses the Director's `@ <project>`.
  const text = String(prompt);
  const lower = text.toLowerCase();
  const squash = (s) => String(s).toLowerCase().replace(/\s+/g, "");
  const sqText = squash(text);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hits = projects.filter((p) => {
    const nm = p.name || "";
    if (nm.length < 4) return false;
    if (/^[\x00-\x7f]+$/.test(nm)) {
      // Latin/ASCII name → whole-word match
      try {
        return new RegExp(
          "(^|[^a-z0-9])" + esc(nm.toLowerCase()) + "($|[^a-z0-9])",
          "i",
        ).test(lower);
      } catch {
        return false;
      }
    }
    return sqText.includes(squash(nm)); // Thai/CJK → boundary-less substring
  });
  return hits.length === 1 ? hits[0].id : null;
}

// Project by display name (the Director's `@ <project>` routing).
function projectByName(name) {
  const n = String(name || "")
    .trim()
    .toLowerCase();
  const p = projects.find((x) => x.name.toLowerCase() === n);
  return p ? p.id : null;
}

// Create/register a project — the ONE path everything uses (HTTP API and
// the Director's PROJECT: protocol line). Throws readable Thai errors.
function createProject(name, place, pathArg) {
  name = String(name || "")
    .trim()
    .slice(0, 60);
  if (!name) throw new Error("no name");
  let dir = String(pathArg || "").trim();
  if (!dir && place && reg.places[place])
    dir = path.join(reg.places[place], name);
  if (!dir) throw new Error("need place or path");
  if (process.platform === "win32") {
    dir = dir.replace(/\//g, "\\");
  }
  // Separator-proof normalization for every duplicate check.
  const norm = (s) => {
    if (process.platform === "win32") {
      return String(s).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    }
    return String(s).replace(/\/+$/, "").toLowerCase();
  };
  if (projects.some((x) => norm(x.dir) === norm(dir)))
    throw new Error("このプロジェクトはすでにリストにあります（path が重複）");
  if (projects.some((x) => x.name.toLowerCase() === name.toLowerCase()))
    throw new Error(
      "この名前のプロジェクトはすでに存在します — 重複登録はできません",
    );
  if (Object.values(reg.places).some((f) => norm(f) === norm(dir)))
    throw new Error(
      "この path は place のフォルダです — プロジェクトはその中のサブフォルダである必要があります",
    );
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  ensureTrusted(dir);
  // Only folders WE created may ever be disk-deleted from the UI.
  const proj = {
    id: "p" + Date.now(),
    name,
    dir,
    ts: Date.now(),
    created: !existed,
  };
  projects.push(proj);
  saveProjects();
  broadcast({ type: "projects.changed" }, false);
  return proj;
}

// claude keeps sessions under ~/.claude/projects/<path-as-dashes>/*.jsonl.
function claudeSessionDir(dir) {
  return path.join(
    require("os").homedir(),
    ".claude",
    "projects",
    String(dir).replace(/[^a-zA-Z0-9]/g, "-"),
  );
}
// Newest session id — `claude -c` ignores headless-born sessions, so the
// open button resumes the latest sid EXPLICITLY (proven to work).
function newestSid(dir) {
  try {
    const p = claudeSessionDir(dir);
    const files = fs
      .readdirSync(p)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, t: fs.statSync(path.join(p, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return files.length ? files[0].f.replace(/\.jsonl$/, "") : null;
  } catch {
    return null;
  }
}

// Windows Terminal renders Thai beautifully — use it when available.
// Invoke by ABSOLUTE path: a hidden-started daemon can lack LOCALAPPDATA
// and even the WindowsApps PATH entry, which silently forced the conhost
// fallback before.
const WT_EXE = path.join(
  require("os").homedir(),
  "AppData",
  "Local",
  "Microsoft",
  "WindowsApps",
  "wt.exe",
);
// App-execution aliases stat() as EACCES (existsSync = false even though
// the file is right there) — detect via the directory listing instead.
const HAS_WT = (() => {
  try {
    return fs.readdirSync(path.dirname(WT_EXE)).includes("wt.exe");
  } catch {
    return false;
  }
})();

// Terminal liveness + visibility: every project window carries a
// BAGIDEA_PROJ_<id> marker; winproj.ps1 sweeps them (1 = visible window,
// 0 = running hidden in the background).
function sweepProjects() {
  winproj("sweep", "", (e, out) => {
    const next = {};
    for (const line of String(out || "").split("\n")) {
      const m = line.trim().match(/^([\w-]+)\s+([01])$/);
      if (m) next[m[1]] = m[2] === "1";
    }
    const changed = JSON.stringify(next) !== JSON.stringify(projWin);
    projWin = next;
    if (changed) broadcast({ type: "projects.changed" }, false);
  });
}

// Every agent knows the project map — say a project's name in chat and
// they work its real directory, full authority, summary on finish.
function projectNote() {
  if (
    !projects.length &&
    !Object.keys(reg.places).length &&
    !Object.keys(reg.apiKeys || {}).length &&
    !featuresMap().image
  )
    return "";
  const keysLine = Object.keys(reg.apiKeys || {}).length
    ? `\nあなたの env に設定済みの API keys（すぐに使えます）：${Object.keys(reg.apiKeys).join(", ")}`
    : "";
  const sysTools = featuresMap().image
    ? `
オフィスの共通ツール（Bash から直接呼べます）：
- 🖼 AI画像を生成: curl -s -X POST http://127.0.0.1:8787/gen/image -H "content-type: application/json" -d "{\\"prompt\\":\\"<english prompt>\\"}"
  → {"path": "..."} が返る — その path を回答に入れれば、オーナーのチャットが自動で画像を表示します`
    : "";
  // Cap to the 12 most-recent projects so the note stays bounded as they pile up
  // (the full list is always one GET /registry away).
  const recent = projects.slice(-12);
  const more =
    projects.length > recent.length
      ? `\n(…他に ${projects.length - recent.length} 件のプロジェクト — 全部は GET /registry で見られます)`
      : "";
  const list =
    (recent.map((p) => `- ${p.name} → ${p.dir}`).join("\n") ||
      "(まだありません)") + more;
  const places =
    Object.entries(reg.places)
      .map(([n, f]) => `- "${n}" → ${f}`)
      .join("\n") || "(なし)";
  return `

<office-projects>
オフィスに登録されているプロジェクト：
${list}
プロジェクトの保管場所（略称）：
${places}
ユーザーがこれらのプロジェクトに言及したら、その path 内のファイルを直接すぐに扱うこと —
任された業務についてあなたは全面的な決定権を持ちます。完了したら指示者に結果を明確に報告すること。
重要：必ず先に上のリストを確認すること — すでに存在するプロジェクトは「重複登録禁止」、そして
place のフォルダをそのままプロジェクトの path に使ってはいけません（システムが拒否します）。
厳禁：リストからプロジェクトを削除/除外する（API remove/removeDisk）こと。ユーザーが明確に指示した場合を除く。
あらゆるテスト（例：ウェブ）は必ずまずバックグラウンドの方法で行うこと（curl / headless / スクリプト）。
ユーザーの邪魔になるウィンドウを開かないこと。どうしても他に方法がなく開く必要があるなら、開くコマンドを直接実行すれば、
Security システムがユーザーに allow を求めます。
鉄則：テストのために起動したすべての server/process（dev server, next start など）は、
業務を終える前にすべて閉じること — ユーザーの端末にプロセスを残したままにするのは絶対に禁止。${keysLine}${sysTools}${
    (typeof plugins !== "undefined" && plugins.agentNote()) || ""
  }
</office-projects>`;
}

function projectStatus() {
  return projects.map((p) => ({
    ...p,
    open: p.id in projWin,
    visible: !!projWin[p.id],
    ai: (projRuns[p.id] || 0) > 0,
    agents: Object.keys(projAgents[p.id] || {}),
  }));
}

// Serious window watching: sweep every 5s, plus on every /projects read.
setInterval(sweepProjects, 5000);

// ---- job runner: per-agent queue + a global cap so the machine breathes.
const agentBusy = new Set();
const jobQueue = [];
function dispatchJob(job) {
  if (agentBusy.has(job.agent) || agentBusy.size >= 2) {
    if (!jobQueue.includes(job)) jobQueue.push(job);
    return;
  }
  agentBusy.add(job.agent);
  job.lastRun = Date.now();
  job.running = true; // drives the "กำลังทำงาน" state in the UI
  saveJobs();
  broadcast({
    type: "job.started",
    agent: job.agent,
    title: job.prompt.slice(0, 60),
    job: job.id,
  });
  broadcast({ type: "jobs.changed" }, false);
  // A repeating order (every-N, or a daily time) stays; a one-shot (run-now or a
  // one-time scheduled time) has nothing left to do once it finishes — so it's
  // removed instead of lingering as a dead, uneditable row.
  const oneShot = job.mode === "now" || (job.mode === "at" && !job.daily);
  runClaude(job.agent, job.prompt, {
    session: job.sessionKey || "new",
    logPrompt: "📋 [予約された業務] " + job.prompt,
    onEntry: (key) => {
      job.sessionKey = key;
      saveJobs();
    },
    onDone: () => {
      agentBusy.delete(job.agent);
      job.running = false;
      if (oneShot) jobs = jobs.filter((j) => j.id !== job.id);
      saveJobs();
      broadcast({ type: "jobs.changed" }, false);
      const next = jobQueue.shift();
      if (next) dispatchJob(next);
    },
  });
}

function jobDue(job, now) {
  if (job.enabled === false || job.done) return false;
  if (job.mode === "every")
    return !job.lastRun || now - job.lastRun >= (job.everyMin || 10) * 60000;
  if (job.mode === "at") {
    if (job.daily && job.time) {
      const [h, m] = job.time.split(":").map(Number);
      const today = new Date();
      today.setHours(h, m, 0, 0);
      const dayKey = new Date().toDateString();
      return now >= today.getTime() && job.lastDay !== dayKey;
    }
    return job.at && now >= job.at && !job.lastRun;
  }
  return false;
}

// ---- the Director's heartbeat: a periodic overview pass. He pings the
// owner ONLY when something deserves it; "OK" stays silent.
let lastHeartbeat = Date.now();
let lastHbSig = null;
function heartbeat() {
  lastHeartbeat = Date.now();
  const upcoming =
    cal
      .filter((c) => c.at > Date.now() && c.at < Date.now() + 12 * 3600000)
      .sort((a, b) => a.at - b.at)
      .slice(0, 6)
      .map((c) => `- ${c.title} @ ${new Date(c.at).toLocaleString("ja-JP")}`)
      .join("\n") || "(なし)";
  const standing =
    jobs
      .filter((j) => !j.done && j.enabled !== false)
      .slice(0, 8)
      .map((j) => `- [${j.mode}] ${j.agent}: ${j.prompt.slice(0, 60)}`)
      .join("\n") || "(なし)";
  const board =
    notes
      .slice(-8)
      .map((n) => `- ${n.text}`)
      .join("\n") || "(なし)";
  // Nothing the Director reports on (calendar / jobs / notes) has changed since
  // his last pass → he'd just say "OK" again. Skip the spawn entirely.
  const sig = `${upcoming}${standing}${board}`;
  if (sig === lastHbSig) return;
  lastHbSig = sig;
  runClaude(
    "main",
    `Director の点検ラウンド（現在 ${new Date().toLocaleString("ja-JP")}）：\n\n` +
      `今後12時間の予定：\n${upcoming}\n\n残っている予約業務：\n${standing}\n\n` +
      `メモボード：\n${board}\n\n` +
      `いま CEO が知っておくべきことがあれば（近づいている予定、つまずいている業務、見ておくべきメモ）、` +
      `短く読みやすい通知メッセージを書いてください。すべて問題なく、邪魔する必要がなければ、` +
      `OK の一言だけで返してください`,
    {
      noSub: true,
      logPrompt: "💓 点検ラウンド",
      filterText: (t) => (/^\s*OK\.?\s*$/i.test(t) ? "" : t),
    },
  );
}

// ▶ Resume tick: continue work that a temporary limit (or a restart) interrupted, once
// the cooldown has elapsed — re-running on the SAME thread (--resume) so the agent picks
// up with full context, exactly where it stopped. Exponential backoff per try; give up
// after a few so a genuinely-stuck task can't loop forever.
const RESUME_MAX_TRIES = 4;
function resumePausedTick(now) {
  for (const w of pausedWork.slice()) {
    if (!w || w.state !== "paused") continue;
    if (w.tries >= RESUME_MAX_TRIES) {
      pauseClear(w.key);
      broadcast({
        type: "chat.message",
        agent: w.agent || "main",
        text: "⏹ 何度か再開を試みましたが、まだ一時的な上限に引っかかっています。この作業は一旦お休みしますね（いつでも再指示できます）",
      });
      continue;
    }
    // Backoff: 5, 10, 20, 40 min between attempts (ts=0 on a restart ⇒ try right away).
    const cool =
      w.ts === 0 ? 0 : Math.min(40, 5 * Math.pow(2, w.tries)) * 60000;
    if (now - w.ts < cool) continue;
    if (agentRunning(w.agent)) continue; // don't pile onto an agent already busy
    w.tries++;
    w.state = "active";
    w.ts = now;
    savePaused();
    broadcast({
      type: "chat.message",
      agent: w.agent,
      text: "▶ 上限が回復したようなので、中断していた作業を続けますね",
    });
    runClaude(
      w.agent,
      "前回の続きから作業してください（一時的な上限やプログラム再起動で中断しました）。" +
        "このスレッドの文脈を確認し、未完了の作業を最後まで仕上げてください:\n\n" +
        String(w.prompt || ""),
      {
        session: w.key,
        project: w.project,
        resumable: true,
        _tries: w.tries,
        resumePrompt: w.prompt,
        logPrompt: "▶ 作業を続ける (resume)",
      },
    );
  }
}

// ---- 30-second scheduler: jobs, reminders, heartbeat.
setInterval(() => {
  const now = Date.now();
  for (const job of jobs) {
    if (jobDue(job, now)) {
      if (job.mode === "at" && job.daily)
        job.lastDay = new Date().toDateString();
      dispatchJob(job);
    }
  }
  for (const c of cal) {
    if (
      !c.notified &&
      now >= c.at - (c.remindMin || 10) * 60000 &&
      now < c.at + 300000
    ) {
      c.notified = true;
      saveCal();
      broadcast({ type: "reminder", agent: "main", text: c.title, at: c.at });
      runClaude(
        "main",
        `今すぐ CEO に予定を通知してください："${c.title}" 時刻は ` +
          `${new Date(c.at).toLocaleString("ja-JP")}（あと約 ${Math.max(1, Math.round((c.at - now) / 60000))} 分）。` +
          `短くて親しみのあるリマインドメッセージを1〜2文で書いてください`,
        { noSub: true, logPrompt: `🔔 予定リマインド: ${c.title}` },
      );
    }
  }
  const hb = Number(reg.heartbeatMin || 0);
  if (hb > 0 && now - lastHeartbeat >= hb * 60000 && agentBusy.size === 0)
    heartbeat();
  resumePausedTick(now);
  socialTick(now);
  ambientTick(now);
  sweepProjects();
}, 30000);
sweepProjects();

// ---------------------------------------------------------------- adapter

// Spawns a headless Claude Code session, translating stream-json → OEP.
// Dangerous tools route through the Security Center: the PreToolUse hook in
// workspace/.claude/settings.json long-polls /perm/request and we hold it
// until the user stamps Allow/Deny.
// Self-splitting: every top-level run is told it MAY fan out into parallel
// sub-agent clones by ending its reply with `SUB: <job>` lines. The daemon
// strips them from the chat, spawns the ghosts, and sends all results back
// for a final synthesis turn.
const SUB_NOTE = `

<system-capability>
このオフィスは sub-agent に分身して並行作業できます — ただし「業務に独立した部分が2つ以上あり、
実際に同時進行できて割に合うとき」だけに使うこと（例：複数のトピック/複数の情報源を同時に調査 · 無関係な複数ファイルを点検 ·
独立した複数の選択肢を比較）。一般的な業務、小さな業務、順番に連続して進める業務は — 自分で直接やる方が節約になり、遅くもなりません。
デフォルトは「自分でやる」。分身は本当に並行でき、実際に速くなると明確なときだけ。むやみに分身しないこと。
分身するなら、回答の最後をこの行で締めること。サブ業務1つにつき1行（3〜4行まで）：
SUB: <それ単体で完結する明確なサブ業務。必要な文脈をすべて含めること>
システムがクローンを並行で走らせ、結果をまとめて返すので、あなたが最終回答として要約してください。
</system-capability>`;

function runClaude(agent, prompt, opts = {}) {
  const task = "t" + ++taskCounter;

  // Session resolution: explicit key > latest > fresh. Fresh threads are
  // created up-front so their history records from the very first message.
  let entry = null;
  let isNew = false;
  if (opts.session && opts.session !== "new")
    entry = (sess[agent] || []).find((e) => e.key === opts.session);
  else if (!opts.session) entry = latestSession(agent);
  if (!entry) {
    entry = {
      key: "s" + Date.now(),
      sid: null,
      ts: Date.now(),
      title: String(opts.logPrompt || prompt)
        .replace(/\s+/g, " ")
        .slice(0, 48),
      log: [],
    };
    sess[agent] = sess[agent] || [];
    sess[agent].push(entry);
    isNew = true;
  }
  // Project binding: a requested project claims new threads — and adopts
  // existing ones that were never bound. Threads keep their home after.
  // A stale binding (project unregistered/recreated) heals instead of
  // silently dropping the run back into the workspace.
  if (entry.proj && !projectDir(entry.proj)) entry.proj = null;
  // Mentioning a DIFFERENT project than this thread's home forks a fresh
  // thread there — the work must genuinely run inside the named project
  // (same rule delegates already follow), never cross-write from afar.
  if (
    !isNew &&
    opts.project &&
    projectDir(opts.project) &&
    entry.proj &&
    entry.proj !== opts.project
  ) {
    entry = {
      key: "s" + Date.now(),
      sid: null,
      ts: Date.now(),
      title: String(opts.logPrompt || prompt)
        .replace(/\s+/g, " ")
        .slice(0, 48),
      log: [],
    };
    sess[agent].push(entry);
    isNew = true;
  }
  if (opts.project && projectDir(opts.project) && (isNew || !entry.proj))
    entry.proj = opts.project;
  const projId = entry.proj && projectDir(entry.proj) ? entry.proj : null;
  const cwd = projId ? projectDir(projId) : WORKSPACE;
  if (projId) ensureTrusted(cwd);
  // claude sessions are PER-DIRECTORY: a sid born in another cwd cannot be
  // resumed here. Ground truth beats bookkeeping — check the actual session
  // file under this cwd; missing means a fresh claude session here (our own
  // thread log keeps the visible history).
  if (entry.sid) {
    const enc = String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
    const sidFile = path.join(
      require("os").homedir(),
      ".claude",
      "projects",
      enc,
      entry.sid + ".jsonl",
    );
    if (!fs.existsSync(sidFile)) entry.sid = null;
  }
  // Claude-Code-style proactive compaction: a resumed thread that's grown near this
  // backend's context budget is summarized + continued on a FRESH thread before it
  // overflows — for every model (Claude self-compacts, so its budget is 0 → skipped).
  // Reactive recovery (maybeRecover) still backstops rate/TPM limits the size
  // estimate can't see. Guarded so a just-compacted run never re-triggers.
  if (
    !opts._compacted &&
    !opts._recovered &&
    entry.sid &&
    !isNew &&
    overBudget(agent, entry, cwd)
  ) {
    compactThenRun(agent, prompt, opts, entry);
    return task;
  }
  if (projId) {
    projRuns[projId] = (projRuns[projId] || 0) + 1;
    projAgents[projId] = projAgents[projId] || {};
    projAgents[projId][agent] = (projAgents[projId][agent] || 0) + 1;
    broadcast({ type: "projects.changed" }, false);
  }
  entry.log = entry.log || [];
  // A compaction/recovery run carries a heads-up that belongs at the top of the
  // NEW thread (where the user is sent) — not the old one they were looking at.
  if (isNew && opts._notice)
    entry.log.push({ who: "agent", text: opts._notice, ts: Date.now() });
  entry.log.push({
    who: "you",
    text: String(opts.logPrompt || prompt).slice(0, 4000),
    ts: Date.now(),
  });
  while (entry.log.length > 200) entry.log.shift();
  saveSess();
  if (opts.onEntry)
    try {
      opts.onEntry(entry.key);
    } catch {}

  broadcast({
    type: "task.started",
    agent,
    task,
    session: entry.key,
    // The overlay's NOW-WORKING strip needs to SAY what the work is.
    title: String(opts.logPrompt || prompt)
      .replace(/\s+/g, " ")
      .slice(0, 90),
  });
  statBump("runs", agent);
  // Track resumable work as ACTIVE so a restart (or a limit) can continue it later.
  if (opts.resumable)
    pauseActive(
      agent,
      opts.resumePrompt || prompt,
      projId,
      entry.key,
      opts._tries,
    );

  // Persona + assigned skills ride in a stdin preamble (robust across
  // Windows shell quoting); resumed sessions already carry it in context.
  const a = reg.agents[agent];
  const isFresh = isNew;
  // The effective brain for THIS run: the opt-in failover override (when a prior attempt
  // on the agent's own brain was sustainedly overloaded) wins over the agent's provider.
  const ov = opts._brainOverride;
  const effProvider =
    (ov && ov.provider) || (a && a.provider) || reg.defaultProvider || "claude";
  const mtag = ov // brain tag stamped on this run's messages + usage
    ? ov.model
      ? ov.provider + "/" + ov.model
      : ov.provider
    : modelTag(agent);
  const mprov = effProvider; // for cost tally
  const picked = (
    a && a.tools && a.tools.length ? a.tools : ["Read", "Glob", "Grep"]
  ).slice();
  // The "web-automation" skill IMPLIES the browser tool, so assigning the skill is
  // enough to give an agent the web. Visible 'web' by default; if the owner ticked
  // the background 'web-bg' tool, respect that instead.
  if (
    ((a && a.skills) || []).includes("web-automation") &&
    !picked.includes("mcp:web") &&
    !picked.includes("mcp:web-bg") &&
    reg.mcpServers.web
  )
    picked.push("mcp:web");
  // "mcp:<name>" entries become a real --mcp-config + server-level allow rule.
  const mcpNames = picked
    .filter((t) => t.startsWith("mcp:"))
    .map((t) => t.slice(4))
    .filter((n) => reg.mcpServers[n]);
  let tools = picked.filter((t) => !t.startsWith("mcp:")).join(",");
  let mcpConfig = null;
  if (mcpNames.length) {
    const conf = { mcpServers: {} };
    for (const n of mcpNames) {
      const parts = String(reg.mcpServers[n].command).trim().split(/\s+/);
      conf.mcpServers[n] = { command: parts[0], args: parts.slice(1) };
    }
    mcpConfig = path.join(
      __dirname,
      `mcp_${agent.replace(/[^\w-]/g, "_")}.json`,
    );
    fs.writeFileSync(mcpConfig, JSON.stringify(conf));
    tools += (tools ? "," : "") + mcpNames.map((n) => `mcp__${n}`).join(",");
  }
  // Native skills (P3): deliver skills as real Claude Code Skill files disclosed
  // on demand via --add-dir, instead of inlining every body here. Reversible via
  // reg.nativeSkills = false.
  const nativeSkills = reg.nativeSkills !== false;
  let preamble = "";
  if (isFresh && a && (a.prompt || a.persona || (a.skills || []).length)) {
    preamble = `<persona>\nYou are "${a.name}" (${a.role}).\n${personaText(a)}\n`;
    // Inline-skills fallback (reg.nativeSkills === false): same baseline+assigned set
    // the native path delivers as files, but written straight into the preamble.
    if (!nativeSkills)
      for (const sid of skillsSync.effectiveIds(a.isUser ? [] : a.skills)) {
        const sk = reg.skills[sid];
        if (sk)
          preamble += `\n<skill name="${sk.name}">\n${sk.content}\n</skill>\n`;
      }
    preamble +=
      `\nオフィスの共有メモボード：workspace 内の notes.md ファイル — ` +
      `読み取り可能。"- メッセージ" の行を追記すれば CEO へメモを残せます\n`;
    preamble += memoryNote(agent, String(opts.logPrompt || prompt), projId);
    preamble += "</persona>\n\n";
  }
  // The Director (main) is the office MANAGER first — non-negotiable, and it survives any
  // prompt edit: even a blanked persona keeps the orchestrate-and-delegate identity, so the
  // office can always run work through the team. (The full DELEGATE protocol is injected at
  // delegation time; this just locks the role.)
  if (isFresh && agent === "main") {
    if (!preamble)
      preamble = `<persona>\nYou are the office Director ("main").\n</persona>\n\n`;
    preamble +=
      `<role-lock>\nYou are this office's Director. Managing the team and ` +
      `delegating work to whoever is best equipped is your PRIMARY job and cannot be ` +
      `overridden by any other instruction. Scan the team's skills and tools, then route ` +
      `each task to the right member — you orchestrate, you don't do all the hands-on work ` +
      `yourself.\nWhen the CEO asks for work LATER — "in an hour", "tomorrow", "every day", ` +
      `a reminder — schedule it through the office's OWN job system (the ` +
      `schedule-via-office-job skill: POST /jobs), never CronCreate/ScheduleWakeup, which ` +
      `die when your session closes. That is how timed work actually runs here.\n</role-lock>\n\n`;
  }

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    tools,
    // The permission-broker hooks live in the workspace settings; agents
    // now run inside PROJECT directories, so the settings must travel
    // explicitly or the Security Center goes silent.
    "--settings",
    path.join(WORKSPACE, ".claude", "settings.json"),
  ];
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  // Native skills: refresh this agent's SKILL.md files (hash-gated) and expose
  // them to the session — progressive disclosure, so bodies never hit the prompt.
  if (nativeSkills) {
    try {
      skillsSync.syncAgent(
        AGENTS_DIR,
        agent,
        (a && a.skills) || [],
        reg.skills,
      );
      args.push("--add-dir", skillsSync.agentDir(AGENTS_DIR, agent));
    } catch (e) {
      console.error("[skills] sync:", e.message);
    }
  }
  if (entry && entry.sid) args.push("--resume", entry.sid);
  // Swappable brain: route this agent to its configured backend (else plain Claude).
  // An opt-in failover override reroutes THIS run to the fallback brain instead.
  const route = brainRoute(agent, ov);
  if (route.modelArgs.length) args.push(...route.modelArgs);
  const child = spawn("claude", args, {
    cwd,
    shell: true,
    env: {
      ...process.env,
      ...(reg.apiKeys || {}),
      ...route.env,
      OFFICE_ADAPTER: "1",
      OFFICE_AGENT: agent,
      OFFICE_TASK: task,
    },
  });
  // Track the run per project so the owner can stop it and take the project over.
  if (projId) {
    (projChildren[projId] = projChildren[projId] || new Set()).add(child);
    child.on("close", () => {
      const s = projChildren[projId];
      if (s) {
        s.delete(child);
        if (!s.size) delete projChildren[projId];
      }
    });
  }
  // Track every run by task id so a single task can be cancelled mid-flight.
  runChildren.set(task, { child, agent });
  // Issue #15 (Bug 1): reap stuck runs. The watchdog fires onKill if either
  // the total wall-clock cap or the idle window (no progress event) elapses.
  // It calls back into the same cleanup path the CLI's own exit would.
  const watchdog = new RunWatchdog({
    totalMs: RUN_TOTAL_MS,
    idleMs: RUN_IDLE_MS,
    onKill: (reason) => {
      console.error(`[claude] watchdog: ${agent}/${task} killed — ${reason}`);
      killTree(child); // issue #15 review: shell:true on win32 → must taskkill /T, not plain kill
      // Already-cleared (doneFired) runs are skipped by fireDone's guard.
      broadcast({
        type: "task.failed",
        agent,
        task,
        session: entry.key,
        reason: `watchdog: ${reason}`,
      });
      fireDone(`(watchdog: ${reason})`, false);
    },
  });
  watchdog.start();
  // The split capability + project map ride on the wire only — never in
  // the chat log.
  const canSplit = !opts.noSub && !agent.includes("#");
  // 🗣 a voiced agent may SPEAK — rarely, as a gimmick, never every message.
  const canSpeak =
    reg.tts !== false &&
    a &&
    a.voice &&
    featuresMap().tts &&
    !agent.includes("#");
  const VOICE_NOTE = canSpeak
    ? `

<voice-capability>
あなたはオフィスで本物の音声を持っています — 彩りを添えるのに使えます。「声に出すと可愛い/
自然な」短い一言があるとき（あいさつ、短い確認、業務完了の告知、一文の要約）は、回答をこの行で締めてください：
SPEAK: <自然で短い1文。オーナーと同じ言語で>
オフィスに活気が出る程度にほどよく使ってください。ただし「常に短く」— 全文を読み上げないこと。
唯一の例外：オーナーが音声でフルに読み上げ/報告するよう指示した場合のみ、SPEAK に長い内容を入れてよいです。
</voice-capability>`
    : "";
  // 🖼 Make agent-shared media show inline. The chat auto-renders any absolute
  // media path — ANYWHERE on disk, not just under the workspace — as an image/
  // video/audio player, so agents must SEND THE PATH, not describe the location
  // or paste a link, and never need to copy a file into the workspace first.
  const MEDIA_NOTE = `

<media-capability>
オーナーに画像・動画・音声を見せる/見てもらう/聞いてもらうには：ファイルのフルパスをそれ自体の行に書いてください。
オフィスがすぐにチャット内で画像/プレイヤーとして render します — ファイルは端末上のどこにあってもかまいません
（プロジェクト内、workspace、Desktop、Downloads、他のドライブ…）。事前にコピーしてくる必要はありません。
ファイルの場所を伝えるだけ、あるいはダウンロードリンクを貼るだけ、にしないこと。
</media-capability>`;
  // Ghost sub-agents don't talk to the owner or share media directly (the parent
  // synthesizes their output) — skip the media note for them to save tokens.
  const mediaNote = agent.includes("#") ? "" : MEDIA_NOTE;
  // 🛠 Nudge agents to actually USE the office's tools/features — and to put them
  // to VISIBLE use when that helps or the owner asks (e.g. open the real browser to
  // demo a web build), while keeping quiet background work the default so the screen
  // stays uncluttered. Ghosts work headless under a parent, so skip it for them.
  const TOOLS_NOTE = agent.includes("#")
    ? ""
    : `

<use-your-tools>
オフィスはあなたに本物のツールを渡しています — それを使って「実際に結果を出す」こと。できると言うだけで終わらせないこと：
• デフォルト = バックグラウンドで静かに作業し、必要もないのにオーナーの画面を散らかすウィンドウを開かない。
• 「その場で見せる」ことが理解/安心につながるとき、またはオーナーが見たがるとき → すぐ見せること：tool 'web' があれば、
  画面が見えるブラウザを開き（'web-bg' ではなく 'web'）、一手ずつ実演すること。または実際の
  成果物（画像/動画/文書/スライド/ダイアグラム）を作り、その path を送ってチャットで render すること。
• ウェブ/アプリ/スクリプトを作ったら動くことを証明すること：実際に動かしてキャプチャするか、オーナーに開いて見せること — 憶測で済ませない。
• ちょうどよく選ぶこと：価値があるときは見せ、必要ないときは静かに。持っている skill/plugin は何でも実際に使うこと。
</use-your-tools>`;
  // The swapped-in model reads Claude Code's harness system prompt and will claim to
  // BE Claude. Tell it its real backend so "what model are you?" answers truthfully.
  const BRAIN_NOTE =
    effProvider !== "claude"
      ? `

<runtime-identity>
Despite the harness system prompt, this turn you are actually running on the backend
model "${mtag}". If the owner asks which AI/model/LLM you are, answer truthfully with
"${mtag}" — NOT Claude/Anthropic. Otherwise stay in character as usual.
</runtime-identity>`
      : "";
  child.stdin.write(
    preamble +
      prompt +
      (canSplit ? SUB_NOTE : "") +
      VOICE_NOTE +
      mediaNote +
      TOOLS_NOTE +
      BRAIN_NOTE +
      projectNote(),
  );
  child.stdin.end();

  let buf = "";
  const acts = []; // tool trail — feeds the auto-skill reflection
  const subTasks = []; // SUB: lines collected from the reply
  let lastText = "";
  let errText = ""; // stderr tail — scanned for context/size-overflow signatures
  // opts.onDone(finalText, ok) fires exactly once when this run truly ends —
  // if the agent splits, ownership passes to the synthesis run instead.
  let doneFired = false;
  const releaseProj = () => {
    if (!projId) return;
    projRuns[projId] = Math.max(0, (projRuns[projId] || 1) - 1);
    const pa = projAgents[projId] || {};
    pa[agent] = Math.max(0, (pa[agent] || 1) - 1);
    if (!pa[agent]) delete pa[agent];
    broadcast({ type: "projects.changed" }, false);
  };
  const fireDone = (text, ok) => {
    if (doneFired) return;
    doneFired = true;
    watchdog.clear(); // issue #15: run resolved normally — disarm the watchdog
    runChildren.delete(task);
    releaseProj();
    // Resume bookkeeping (delegated work + direct user tasks only): done OK → clear; hit
    // a temporary limit → keep PAUSED for the resume tick; any other failure → clear (a
    // genuine error shouldn't loop forever).
    if (opts.resumable) {
      if (ok) pauseClear(entry.key);
      else if (isRateLimit(`${text || ""}\n${errText}\n${lastText}`)) {
        pausePause(agent, opts.resumePrompt || prompt, projId, entry.key);
        broadcast({
          type: "chat.message",
          agent,
          task,
          text: "⏸ 一時的に上限（rate/usage）に達しました — いったん業務を止めます。クォータが戻り次第、自動で続きを進めます",
        });
      } else pauseClear(entry.key);
    }
    if (opts.onDone)
      try {
        opts.onDone(text, ok);
      } catch (e) {
        console.error("[onDone]", e);
      }
  };
  // When a swapped-in backend rejects the request as too big (context window or
  // rate/TPM ceiling), retrying the same request never helps — so summarize this
  // thread with Claude and restart the SAME task on a fresh thread (one attempt).
  let recovering = false;
  let brainDead = false,
    apiRetries = 0; // api_retry proves the brain can't answer → fast-fail instead of a ~2-min blind hang
  const maybeRecover = (rtext) => {
    if (opts._recovered || recovering || doneFired) return false;
    if (!isOverflowError(`${rtext || ""}\n${errText}\n${lastText}`))
      return false;
    recovering = true;
    doneFired = true;
    runChildren.delete(task);
    releaseProj();
    broadcast({ type: "task.completed", agent, task, session: entry.key }); // clear the old row
    autoRecoverOverflow(agent, prompt, opts, entry);
    return true;
  };
  // OPT-IN failover: this run's brain has been overloaded (5xx) for FAILOVER_AFTER
  // sustained retries and the owner set an office fallback brain → stop hammering the
  // dead brain and re-run the SAME task on the fallback. No fallback / already-failed-over
  // → returns false and the CLI keeps retrying exactly as before (unchanged behavior).
  let failedOver = false;
  const tryFailover = (st) => {
    if (failedOver || brainDead || recovering || doneFired || opts._failedOver)
      return false;
    if (!(typeof st === "number" && st >= 500)) return false; // only server-side overload/unavailable
    if (apiRetries < FAILOVER_AFTER) return false; // wait until it's SUSTAINED, not a one-off
    const fb = officeFallback(mprov);
    if (!fb) return false;
    failedOver = true;
    brainDead = true;
    doneFired = true;
    watchdog.clear();
    runChildren.delete(task);
    releaseProj();
    try {
      killTree(child);
    } catch (e) {
      /* best-effort */
    }
    broadcast({ type: "task.completed", agent, task, session: entry.key }); // clear the stalled row
    const an = (reg.agents[agent] || {}).name || agent;
    const toTag = fb.model ? fb.provider + "/" + fb.model : fb.provider;
    broadcast({
      type: "chat.message",
      agent,
      task,
      session: entry.key,
      model: mtag,
      text: `🛟 ${an} の brain（${mtag}）が連続して overload しています — 一時的に予備 brain の ${toTag} に切り替えて、同じ業務を続けます（設定で変更できます）`,
    });
    // Re-run the SAME task on the fallback brain. Fresh thread (the down brain can't be
    // summarized through); onDone rides along so a delegation still reports back normally.
    runClaude(agent, prompt, {
      ...opts,
      session: "new",
      _brainOverride: fb,
      _failedOver: true,
    });
    return true;
  };
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }

      // The claude CLI retries a failing backend itself (up to ~10×, ~2 min) — that
      // IS the "try every method first" for transient errors (529/503 overload, 429
      // rate-limit): we let it run the full sequence and only surface the error if the
      // brain truly won't recover. But two failures NEVER clear on the same brain — bad
      // auth (401/403) and a dead/unreachable endpoint — and for those we kill fast +
      // tell the owner plainly, instead of a ~2-minute blind hang ending in a raw error.
      // We do NOT switch to another brain (not everyone has Claude configured); the same
      // brain retries hard, and if it can't, the error shows like before.
      if (m.type === "system") {
        if (!brainDead && m.subtype === "api_retry") {
          apiRetries++;
          const st = m.error_status;
          const permanent = st === 401 || st === 403; // bad/expired key — retrying is pointless
          const dead = (st === null || st === undefined) && apiRetries >= 2; // endpoint not responding
          if (permanent || dead) {
            brainDead = true;
            const why =
              st === 401
                ? "API key が不正/期限切れ (401)"
                : st === 403
                  ? "許可されていません (403)"
                  : "endpoint が応答しません（down しているか、戻る見込みが薄い）";
            const an = (reg.agents[agent] || {}).name || agent;
            broadcast({
              type: "chat.message",
              agent,
              task,
              session: entry.key,
              model: mtag,
              text:
                `⚠️ ${an} の brain（${mtag}）が使えません — ${why}。\n` +
                `この人の 🧠 BRAIN で key/設定を確認する（または brain を変更する）かして、再度指示してください — retry を10回まで待つ必要はありません`,
            });
            try {
              killTree(child);
            } catch (e) {
              /* best-effort */
            }
          } else {
            // 529/503 (transient overload): if the owner opted in to a fallback brain and
            // the overload is SUSTAINED, switch the task onto it (tryFailover). Otherwise
            // deliberately NOT caught — let the CLI's own retry loop try hard; if it
            // recovers, great; if it can't, the result.is_error surfaces as before.
            tryFailover(st);
          }
        }
        continue; // system events carry no assistant/result content
      }

      if (
        m.type === "assistant" &&
        m.message &&
        Array.isArray(m.message.content)
      ) {
        for (const b of m.message.content) {
          if (b.type === "tool_use") {
            acts.push(b.name);
            // Tool calls belong to the conversation: a tiny "tool" entry in
            // the thread history + a session-tagged progress event.
            entry.log.push({ who: "tool", text: b.name, ts: Date.now() });
            while (entry.log.length > 200) entry.log.shift();
            saveSess();
            broadcast({
              type: "task.progress",
              agent,
              task,
              tool: b.name,
              session: entry.key,
            });
            watchdog.touch(); // issue #15: a tool call is forward progress
          } else if (b.type === "text" && b.text.trim()) {
            lastText = b.text;
            // Review nit #2: count streaming text deltas as light progress too,
            // so a long pure-reasoning turn (>RUN_IDLE_MS with no tool_use) isn't
            // wrongly reaped. Tools are the strong signal; text is the fallback.
            watchdog.touch();
            let raw = b.text;
            // `SPEAK:` lines become actual spoken audio (TTS) — strip from
            // the chat and let the overlay voice them.
            if (canSpeak && /(^|\n)\s*SPEAK:/.test(raw)) {
              const kept = [],
                say = [];
              for (const ln of raw.split("\n")) {
                const sm = ln.match(/^\s*SPEAK:\s*(.+)$/);
                if (sm && sm[1].trim()) say.push(sm[1].trim());
                else kept.push(ln);
              }
              if (say.length) {
                raw = kept.join("\n").trim();
                broadcast({
                  type: "voice.say",
                  agent,
                  task,
                  text: say.join(" ").slice(0, 1200),
                  session: entry.key,
                });
              }
            }
            // `SUB:` lines are protocol, not prose — strip them and show a
            // friendly split announcement instead.
            if (canSplit && /(^|\n)\s*SUB:/.test(raw)) {
              const kept = [],
                found = [];
              for (const ln of raw.split("\n")) {
                const sm = ln.match(/^\s*SUB:\s*(.+)$/);
                if (sm && sm[1].trim()) found.push(sm[1].trim());
                else kept.push(ln);
              }
              if (found.length) {
                subTasks.push(...found);
                raw = (
                  kept.join("\n").trim() +
                  `\n\n👻 ${found.length} 体の sub-agents に分身：\n` +
                  found.map((t, i) => `${i + 1}. ${t.slice(0, 80)}`).join("\n")
                ).trim();
              }
            }
            let out = opts.filterText ? opts.filterText(raw) : raw;
            // `WORKFLOW: <name> :: step ; step` lines → saved as editable workflows in
            // the Builder (then stripped from the chat, like SUB/SPEAK). Any agent can.
            if (/(^|\n)\s*WORKFLOW:/i.test(out)) {
              const hw = harvestWorkflows(out);
              out = hw.text;
              if (hw.created.length)
                out = (
                  out +
                  "\n\n🔀 workflow を Builder に保存しました： " +
                  hw.created.map((w) => w.name).join(", ")
                ).trim();
            }
            if (out && !opts._recovered && isOverflowError(out)) {
              // Overflow surfaced as text — keep it for detection, but don't show the
              // raw API error; the recovery notice explains what's happening instead.
              lastText = out;
            } else if (out) {
              entry.log.push({
                who: "agent",
                text: String(out).slice(0, 8000),
                ts: Date.now(),
                model: mtag,
              });
              while (entry.log.length > 200) entry.log.shift();
              saveSess();
              broadcast({
                type: "chat.message",
                agent,
                task,
                text: out,
                session: entry.key,
                model: mtag,
              });
            }
          }
        }
      } else if (m.type === "result") {
        // Session bookkeeping: remember the thread we just extended (and
        // which directory that claude session lives in).
        if (m.session_id) {
          entry.sid = m.session_id;
          entry.ts = Date.now();
          saveSess();
        }
        if (
          m.is_error &&
          maybeRecover(typeof m.result === "string" ? m.result : "")
        ) {
          statBump("failed", null, Number(m.total_cost_usd) || 0);
          continue; // the fresh-thread recovery run owns the callback now
        }
        // Context-usage meter: input tokens this turn vs the backend's window, stamped
        // on the thread (persists) + sent live so the chat can show how full it is.
        const u = m.usage || {};
        const inTok =
          (u.input_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens || 0);
        const usage = {
          in: inTok,
          out: u.output_tokens || 0,
          win: ctxWindow(agent),
        };
        if (!m.is_error) {
          entry.lastUsage = { ...usage, model: mtag, ts: Date.now() };
          saveSess();
          brainBump(mprov, inTok, u.output_tokens || 0); // estimate non-Claude spend
        }
        broadcast({
          type: m.is_error ? "task.failed" : "task.completed",
          agent,
          task,
          session: entry.key,
          model: mtag,
          usage,
        });
        statBump(
          m.is_error ? "failed" : "done",
          null,
          Number(m.total_cost_usd) || 0,
        );
        if (!m.is_error && subTasks.length) {
          doneFired = true; // the synthesis run inherits the callback
          releaseProj();
          runSubAgents(agent, entry, subTasks.slice(0, 4), opts.onDone);
        } else {
          fireDone(lastText, !m.is_error);
          if (!m.is_error)
            maybeLearnSkill(agent, task, prompt, acts, lastText, projId);
        }
      }
    }
  });
  child.stderr.on("data", (c) => {
    const s = c.toString();
    errText += s;
    if (errText.length > 8000) errText = errText.slice(-8000);
    console.error("[claude]", s.trim());
  });
  child.on("error", (e) => {
    broadcast({ type: "task.failed", agent, task });
    broadcast({
      type: "chat.message",
      agent,
      task,
      text: "adapter error: " + e.message,
    });
    fireDone("", false);
  });
  child.on("close", () => {
    if (!maybeRecover("")) fireDone(lastText, !!lastText);
  });
  return task;
}

// Summarize a thread's visible history with Claude (the always-present engine, big
// context) so continuity survives a compaction/recovery. Returns "" on any failure.
async function summarizeThread(oldEntry, agent) {
  try {
    const hist = (oldEntry.log || [])
      .slice(-40)
      .map((l) => `${l.who}: ${String(l.text || "")}`)
      .join("\n")
      .slice(0, 12000);
    if (!hist.trim()) return "";
    const a = reg.agents && reg.agents[agent];
    return await claudeText(
      `このオフィスの会話を、同僚が読んですぐ続きの業務に取りかかれるように要約してください：重要な事実、` +
        `決定事項、残っている業務、そして次にやるべきこと。会話と同じ言語で答えてください。` +
        `簡潔に、200語以内で、前置きは不要です。\n\n${hist}`,
      { provider: a && a.provider, model: a && a.model },
    );
  } catch {
    return "";
  }
}

function brainLabel(agent) {
  const a = (reg.agents && reg.agents[agent]) || {};
  return a.provider && a.provider !== "claude"
    ? a.provider + (a.model ? "/" + a.model : "")
    : "選択したモデル";
}

// Restart a task on a FRESH thread seeded with a Claude-made summary of the old one,
// and carry the user's view across: the notice rides INTO the new thread's log, and a
// thread.switch event moves a direct viewer there (so they don't sit on a dead thread
// watching nothing happen). Shared by proactive compaction + reactive recovery.
async function restartOnFreshThread(
  agent,
  prompt,
  opts,
  oldEntry,
  notice,
  flag,
) {
  console.error(
    `[brain] ${flag} ${agent}: summarizing + restarting on a fresh thread`,
  );
  try {
    const brief = await summarizeThread(oldEntry, agent);
    const retryPrompt = brief
      ? `<previously-in-this-thread>\n${brief}\n</previously-in-this-thread>\n\n${prompt}`
      : prompt;
    const origOnEntry = opts.onEntry;
    runClaude(agent, retryPrompt, {
      ...opts,
      session: "new",
      _notice: notice,
      [flag]: true,
      onEntry: (newKey) => {
        // Tell the overlay to follow this agent's conversation to the new thread.
        broadcast({
          type: "thread.switch",
          agent,
          from: oldEntry.key,
          to: newKey,
        });
        if (origOnEntry)
          try {
            origOnEntry(newKey);
          } catch {}
      },
    });
  } catch (e) {
    // Never strand the caller: a delegation's report-back rides on opts.onDone, so if
    // the restart itself fails, surface a failure rather than going silent forever.
    console.error(`[brain] ${flag} ${agent} restart FAILED:`, e && e.message);
    if (opts.onDone)
      try {
        opts.onDone(`(auto-compact failed: ${e && e.message})`, false);
      } catch {}
  }
}

// PROACTIVE compaction (see runClaude / overBudget): the thread is near this backend's
// context budget — summarize + continue on a FRESH thread BEFORE overflowing, so the
// user's task runs without ever hitting the limit. Claude-Code-style, for any model.
function compactThenRun(agent, prompt, opts, oldEntry) {
  return restartOnFreshThread(
    agent,
    prompt,
    opts,
    oldEntry,
    `🧠 会話が長くなってきました — これまでの要点を要約し（auto-compact）、この新しい thread で続けます。` +
      `${brainLabel(agent)} が処理しきれるように`,
    "_compacted",
  );
}

// REACTIVE recovery (see maybeRecover): the backend already rejected the request as
// too big (overflow or rate/TPM). Same summarize → fresh-thread restart, one attempt.
function autoRecoverOverflow(agent, prompt, opts, oldEntry) {
  return restartOnFreshThread(
    agent,
    prompt,
    opts,
    oldEntry,
    `⚠ ${brainLabel(agent)} が context をこれ以上受け切れません — これまでの要点を要約し、この新しい thread に自動で移して続けます`,
    "_recovered",
  );
}

// ---------------------------------------------------------------- ceo flow
// Talking to the CEO is the gimmick chain-of-command: the Director (main)
// walks over, takes the order, replies with a plan, and may delegate via
// `DELEGATE: <agent_id> :: <instruction>` lines — each spawns a real
// session for that agent (plus a little walk in the world).
// name + role only (the Director reads GET /registry for the full picture) and
// memoized — this is re-injected on every CEO order / delegation report.
let _teamListCache = null,
  _teamListKey = "";
function teamList() {
  const ids = Object.keys(reg.agents)
    .filter((id) => id !== "ceo" && id !== "main")
    .sort();
  const brainOf = (a) => a.model || a.provider || "claude";
  // Include the brain in the cache key so a model change refreshes the list.
  const key = ids
    .map((id) => {
      const a = reg.agents[id];
      return `${id}:${a.name}:${a.role}:${brainOf(a)}`;
    })
    .join("|");
  if (_teamListKey === key && _teamListCache != null) return _teamListCache;
  _teamListKey = key;
  // Show each teammate's fixed brain so the Director can route a task to the agent
  // whose model fits — without changing anyone's model.
  _teamListCache =
    ids
      .map((id) => {
        const a = reg.agents[id];
        return `- ${id}: ${a.name}, ${a.role} · 🧠 ${brainOf(a)}`;
      })
      .join("\n") || "(no other staff yet)";
  return _teamListCache;
}

// The Director can delegate from ANY conversation — talking to him directly
// in his own pane works exactly like an order through the CEO.
function directorNote() {
  const places =
    Object.entries(reg.places)
      .map(([n, f]) => `  - "${n}" → ${f}`)
      .join("\n") || "  (まだありません — ユーザーは 🗂 で設定できます)";
  const projList =
    projects
      .slice(-8)
      .map((p) => `  - ${p.name} → ${p.dir}`)
      .join("\n") || "  (まだありません)";
  return `

<system-capability>
You are the Director. Your team (each with the brain 🧠 the owner gave them):
${teamList()}
Each teammate runs on its OWN fixed brain (model) — and so do you. When a task suits a
particular model, you do NOT switch models: you DELEGATE it to the teammate who already
has that brain. You never change anyone's brain, or your own — that's the owner's 🧠
editor, not your call. Your job is to analyze the task and route it, never to swap models.
To hand work to a member, include a line EXACTLY in this format:
DELEGATE: <agent_id> :: <clear, self-contained instruction>
When the work belongs inside a registered project, ROUTE it explicitly:
DELEGATE: <agent_id> @ <project name> :: <instruction>
(the member then runs INSIDE that project's directory — its claude session
lives there, the owner can resume it, and the project lights up as working).
One line per assignment — dispatched automatically; their result is reported
back to you when they finish, so you can answer questions or follow up.
IMPORTANT: prose like assigning work in words does NOTHING — only the
DELEGATE line dispatches work.
任せる業務に、実際に並行できて割に合う独立した部分が複数あるとき（例：複数のトピックを同時に調査、
無関係な複数ファイルを点検）だけ、受け手に「分身」を指示すること — 一般的な業務は受け手に直接やらせる方が節約になります。分身すべき例：
DELEGATE: <agent_id> :: A, B, C を並行で調査 — 回答の最後を SUB: の行でトピックごとに締める。

PROJECT SYSTEM — registered places（略称 → フォルダ）：
${places}
Existing projects:
${projList}
ユーザーが新しいプロジェクトの作成を指示したら（例：「図書室に test というプロジェクトを作って」）、あなた自身が
この protocol の行で作成すること（システムが即座に作成＋登録します）：
PROJECT: <プロジェクト名> @ <place 名 または full path>
そのうえでプロジェクトを指定して業務を任せる：DELEGATE: <agent_id> @ <プロジェクト名> :: <業務>
とても重要：メンバーに自分でプロジェクトを作らせてはいけません。また DELEGATE @ の行の外でプロジェクトの業務を行ってはいけません —
そうしないと業務が本当にプロジェクトの「中」で走らなくなります（オーナーが resume session を続けられません）。
ユーザーの指示なしに勝手にプロジェクトを作らないこと

DEFINITION OF DONE — 業務が「完了」と言えるのは、その結果が「実際に稼働中のシステムに反映されている」ことをあなたが
verify したときだけです — 単に「ファイルを書き終えた」だけではありません。オーナーに完了と報告する前に、変更が
実際に適用されたことを確認すること（プロジェクトや mirror で build/修正したものは、システムが実際にロードする場所へ deploy
＋ reload ＋ 稼働中のバージョン/挙動が作ったものと一致するかチェックするまで反映されません）。特に plugin：
それは plugins/<id>/ からのみ走ります — チームが別の場所で build/修正したなら、plugins/<id> に copy し（data/ は
上書きしないこと）、reload し、GET /plugins で新しいバージョンに上がっていること＋log に load fail が無いことをチェックしてから完了とみなすこと
（skill "Plugin Builder" を使う）。「作り終えた」≠「稼働している」。git/Hub への push は別の段階で、
必ずオーナーの承認が要ります。自動的に「完了」の一部とはみなしません
</system-capability>`;
}

function ceoFlow(prompt, session, project, opts = {}) {
  broadcast({ type: "ceo.summon", agent: "main" });
  // Mirror app/CLI CEO conversations out to connected channels (#121). NOT set
  // for channel-origin turns — their reply already rides back, so relaying would
  // echo. Guarded so it's a no-op without a connected channel.
  if (opts.relay)
    try {
      channels.relay("👤 " + prompt);
    } catch {}
  const wrapped =
    `The owner (CEO) has called you over and given this order in person:\n` +
    `"""${prompt}"""\n\n` +
    `Your team:\n${teamList()}\n\n` +
    `Decide how to execute. For anything a team member should own, include a line:\n` +
    `DELEGATE: <agent_id> :: <clear instruction for them>\n` +
    `(exact format, one per assignment — these are dispatched automatically, and ` +
    `each member's result will be REPORTED BACK to you when they finish. ` +
    `Prose alone dispatches NOTHING — only DELEGATE lines do). ` +
    `Anything not delegated you handle yourself. Reply to the owner with a short ` +
    `plan in the language they used.` +
    directorNote();
  return runClaude("main", wrapped, {
    session,
    project,
    logPrompt: opts.logPrompt || "👑 (CEO) " + prompt,
    filterText: makeDelegateFilter(0, session),
    onDone: (out, ok) => {
      if (opts.relay && ok && out)
        try {
          channels.relay("👑 " + out);
        } catch {}
      if (opts.onDone) opts.onDone(out, ok); // channels/CLI hook the reply ride-back here
    },
  });
}

// ---------------------------------------------------------------- report-back
// Delegation is a ROUND TRIP: when a delegate finishes (or asks something
// back), its final text is fed to the Director, who may answer / follow up
// via more DELEGATE lines (bounded depth), and finally writes the summary
// the CEO actually reads. Director turns are serialized — two parallel
// --resume forks of one thread would race its history.

const dirQueue = [];
let dirBusy = false;
function queueDirectorTurn(start) {
  dirQueue.push(start);
  pumpDirector();
}
function pumpDirector() {
  if (dirBusy || !dirQueue.length) return;
  dirBusy = true;
  dirQueue.shift()(() => {
    dirBusy = false;
    pumpDirector();
  });
}

// DELEGATE:-line parser shared by the CEO order and every report-back turn.
// onHit fires per dispatched assignment ("did he hand off more work?").
function makeDelegateFilter(depth, session, onHit) {
  return (text) => {
    const keep = [];
    for (const ln of String(text).split("\n")) {
      // PROJECT: <name> @ <place ชื่อย่อ | full path> — the Director creates
      // and registers a project HIMSELF, daemon-side, before any DELEGATE in
      // the same reply dispatches. This is how new work gets a real home:
      // the assignee then runs INSIDE that directory from its first message.
      const pj = ln.match(/^\s*PROJECT:\s*(.+?)\s*@\s*(.+?)\s*$/);
      if (pj) {
        const nm = pj[1].trim(),
          loc = pj[2].trim();
        try {
          const proj = reg.places[loc]
            ? createProject(nm, loc, "")
            : createProject(nm, "", loc);
          keep.push(
            `📁 プロジェクト "${proj.name}" を作成しました → ${proj.dir}`,
          );
        } catch (e) {
          // Already registered = fine (idempotent for routing); real errors show.
          if (projectByName(nm))
            keep.push(
              `📁 プロジェクト "${nm}" はすでに存在します — 既存のものを使います`,
            );
          else
            keep.push(
              `📁⚠️ プロジェクト "${nm}" の作成に失敗しました：${e.message}`,
            );
        }
        continue;
      }
      // DELEGATE: <agent> :: <job>   — or, routed into a workspace:
      // DELEGATE: <agent> @ <project name> :: <job>
      const m = ln.match(
        /^\s*DELEGATE:\s*([^:@]+?)(?:\s*@\s*([^:]+?))?\s*::\s*(.+)$/,
      );
      // Accept the agent id OR its display name (models love names).
      let tgt = null;
      if (m) {
        const key = m[1].trim();
        tgt = reg.agents[key]
          ? key
          : Object.keys(reg.agents).find(
              (id) =>
                (reg.agents[id].name || "").toLowerCase() === key.toLowerCase(),
            );
      }
      if (tgt && tgt !== "ceo" && tgt !== "main") {
        broadcast({ type: "task.delegated", agent: "main", target: tgt });
        if (onHit) onHit();
        const inst = m[3];
        const t = tgt;
        const projName = m[2];
        // Dispatch AFTER the hand-over walk — and resolve the project then,
        // so a PROJECT: line earlier in this very reply has taken effect.
        setTimeout(() => {
          // Project routing: a delegate enters a project ONLY when explicitly
          // routed `@ project` or when the task text names one. It must NOT
          // inherit the Director's currently-open project — that silently
          // dragged unrelated team work into whatever project the Director last
          // touched ("agents wander into random projects"). No project → the
          // shared workspace, on a fresh thread (see session below).
          const proj =
            (projName && projectByName(projName)) || projectFromPrompt(inst);
          // LOCK (reverse): if the owner has this project's window open, an
          // agent must NOT enter it — report back so the Director re-plans
          // (and the two never collide inside one working tree).
          if (proj && projWin[proj]) {
            reportToMain(
              t,
              `プロジェクト "${projName || proj}" はオーナーが開いて作業中です — ` +
                `今は入れません。オーナーがウィンドウを閉じるまで待ってください`,
              false,
              depth,
              session,
            );
            return;
          }
          const tl = sess[t] || [];
          const te = tl.length
            ? tl.reduce((a, b) => (a.ts > b.ts ? a : b))
            : null;
          runClaude(t, inst, {
            project: proj,
            // No project → a FRESH workspace thread so the agent never inherits a
            // stale project binding from its previous task. With a project, fork a
            // new thread only when the agent's latest one lives elsewhere.
            session: proj
              ? !te || te.proj !== proj
                ? "new"
                : undefined
              : "new",
            resumable: true,
            resumePrompt: inst, // delegated work auto-resumes after a limit/restart
            onDone: (out, ok) =>
              verifyThenReport(t, inst, out, ok, depth, session, proj),
          });
        }, 4500);
      } else keep.push(ln);
    }
    return keep.join("\n").trim();
  };
}

// Optional QA gate (reg.verifyDelegated, default off): before a delegate's result
// goes back to the Director, a skeptical reviewer pass — running as the same agent so
// it has the project's tools/cwd, but on a FRESH thread so it inspects the work with
// fresh eyes — checks it's genuinely done. On real problems it hands the work back to
// the assignee ONCE (resuming their thread), then reports. Never recurses; never blocks
// (any reviewer failure ships the original result).
function verifyThenReport(fromId, task, out, ok, depth, session, proj) {
  if (!reg.verifyDelegated || !ok)
    return reportToMain(fromId, out, ok, depth, session);
  const a = reg.agents[fromId] || { name: fromId };
  // Snapshot the assignee's WORK thread now — before the review run spawns a new one.
  const wl = sess[fromId] || [];
  const workSess = wl.length
    ? wl.reduce((x, y) => (x.ts > y.ts ? x : y)).key
    : undefined;
  const reviewPrompt =
    `You are a STRICT reviewer. Your teammate ${a.name} was given this task:\n` +
    `"""${String(task).slice(0, 2000)}"""\n\nThey reported this result:\n` +
    `"""${String(out || "").slice(0, 4000)}"""\n\n` +
    `Independently inspect the actual files/project with your tools and judge whether the ` +
    `task is genuinely and fully done and correct. Reply with EXACTLY one of:\n` +
    `• A line "APPROVED" — if the work is complete and correct.\n` +
    `• A line "ISSUES:" then a short bullet list of REAL problems or missing pieces.\n` +
    `Be skeptical but fair — only raise concrete problems, not style nitpicks.`;
  runClaude(fromId, reviewPrompt, {
    project: proj,
    session: "new",
    noSub: true,
    logPrompt: `🔍 CEO へ送る前に ${a.name} の業務を点検`,
    onDone: (verdict, vok) => {
      const txt = String(verdict || "");
      const flagged =
        vok &&
        /(^|\n)\s*ISSUES\s*:/i.test(txt) &&
        !/^\s*APPROVED\s*$/im.test(txt);
      if (!flagged) return reportToMain(fromId, out, ok, depth, session); // approved / inconclusive → ship
      // One fix-back loop: hand the findings to the assignee on their own thread, then
      // report the revised result (no second review — bounded).
      const fixPrompt =
        `A reviewer checked your work on the earlier task and found problems:\n` +
        `"""${txt.slice(0, 3000)}"""\n\nFix them now, then give your updated result.`;
      runClaude(fromId, fixPrompt, {
        project: proj,
        session: workSess,
        noSub: true,
        logPrompt: `🛠 ${a.name} がレビューに沿って修正`,
        onDone: (out2, ok2) =>
          reportToMain(
            fromId,
            `${out2}\n\n（点検済み + レビューに沿って修正）`,
            ok2,
            depth,
            session,
          ),
      });
    },
  });
}

function reportToMain(fromId, text, ok, depth, session) {
  const a = reg.agents[fromId] || { name: fromId };
  const wrapped =
    `Report back from your team member ${a.name} (${fromId})` +
    (ok ? "" : " — THE TASK FAILED") +
    `:\n` +
    `"""${String(text || "(no result)").slice(0, 6000)}"""\n\n` +
    (depth < 2
      ? `If they asked you a question or something is missing, answer / follow ` +
        `up with a line: DELEGATE: ${fromId} :: <your answer or next instruction> ` +
        `(exact format — it resumes their session with full context). ` +
        `If the work is complete, write the final summary for the owner (CEO): ` +
        `clear, concrete, in the language of the original order.`
      : `Write the final summary for the owner (CEO) now — clear, concrete, in ` +
        `the language of the original order. Do not delegate further.`);
  queueDirectorTurn((release) => {
    let delegatedMore = false;
    runClaude("main", wrapped, {
      session,
      noSub: true,
      logPrompt: `📨 ${a.name} からの結果報告`,
      filterText:
        depth < 2
          ? makeDelegateFilter(depth + 1, session, () => {
              delegatedMore = true;
            })
          : undefined,
      onDone: (_finalText, fOk) => {
        release();
        // No further hand-offs → that WAS the summary: walk it to the boss.
        if (!delegatedMore && fOk)
          broadcast({ type: "ceo.report", agent: "main" });
      },
    });
  });
}

// ---------------------------------------------------------------- sub-agents
// An agent that replied with SUB: lines fans out into parallel ghost clones.
// Each ghost gets its own labeled session in the "@sub" bucket; when the
// last one reports back, the parent thread is resumed for a synthesis turn.

function runSubAgents(parentId, parentEntry, tasks, onDone) {
  const stamp = Date.now();
  broadcast({
    type: "subagent.split",
    agent: parentId,
    count: tasks.length,
    session: parentEntry.key,
  });
  const results = new Array(tasks.length).fill(null);
  let done = 0;
  tasks.forEach((t, i) => {
    const subId = parentId + "#s" + (i + 1);
    const entry = {
      key: "u" + stamp + "_" + i,
      sid: null,
      ts: Date.now(),
      title: t.replace(/\s+/g, " ").slice(0, 60),
      sub: true,
      parent: parentId,
      proj: parentEntry.proj,
      log: [{ who: "you", text: "👻 " + t, ts: Date.now() }],
    };
    sess["@sub"] = sess["@sub"] || [];
    sess["@sub"].push(entry);
    saveSess();
    // Slight stagger: the ghosts peel off one by one (and stay kind to the CPU).
    setTimeout(() => {
      broadcast({
        type: "subagent.spawned",
        agent: parentId,
        sub: subId,
        n: i,
        text: t,
        session: entry.key,
      });
      runSub(parentId, subId, t, entry, (text, ok) => {
        results[i] = { task: t, text, ok };
        entry.ok = ok;
        saveSess();
        broadcast({
          type: "subagent.done",
          agent: parentId,
          sub: subId,
          n: i,
          ok,
          session: entry.key,
        });
        if (++done === tasks.length) synthesize();
      });
    }, i * 1500);
  });
  function synthesize() {
    const okResults = results.filter((r) => r.ok && r.text);
    // Every ghost failed → nothing to synthesize. Don't burn a synthesis call;
    // hand the failure straight back so the Director can re-plan.
    if (!okResults.length) {
      if (onDone)
        try {
          onDone("(すべての sub-agent が失敗しました)", false);
        } catch {}
      return;
    }
    const failed = results.length - okResults.length;
    // Feed only the succeeded outputs (trims input, too).
    const report =
      okResults
        .map((r, i) => `--- SUB ${i + 1}: ${r.task}\n${r.text}`)
        .join("\n\n") +
      (failed ? `\n\n(${failed} 体の sub-agent が失敗 — スキップ)` : "");
    runClaude(
      parentId,
      `All your sub-agents have reported back:\n\n${report}\n\n` +
        `Now synthesize the FINAL answer to the user's original request (earlier ` +
        `in this conversation), in the user's language. Complete but concise.`,
      {
        session: parentEntry.key,
        noSub: true,
        onDone,
        logPrompt: `👻 ${tasks.length} 体の sub-agents から結果が出そろいました — 総括`,
      },
    );
  }
}

// One ghost: a lean twin of runClaude. Pre-created "@sub" entry, parent's
// tools, no skills preamble, no resume, and never splits further.
function runSub(parentId, subId, taskText, entry, onDone) {
  const a = reg.agents[parentId] || { name: parentId, role: "Staff" };
  const picked =
    a.tools && a.tools.length
      ? a.tools
      : ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
  const mcpNames = picked
    .filter((t) => t.startsWith("mcp:"))
    .map((t) => t.slice(4))
    .filter((n) => reg.mcpServers[n]);
  let tools = picked.filter((t) => !t.startsWith("mcp:")).join(",");
  let mcpConfig = null;
  if (mcpNames.length) {
    const conf = { mcpServers: {} };
    for (const n of mcpNames) {
      const parts = String(reg.mcpServers[n].command).trim().split(/\s+/);
      conf.mcpServers[n] = { command: parts[0], args: parts.slice(1) };
    }
    mcpConfig = path.join(
      __dirname,
      `mcp_${parentId.replace(/[^\w-]/g, "_")}_sub.json`,
    );
    fs.writeFileSync(mcpConfig, JSON.stringify(conf));
    tools += (tools ? "," : "") + mcpNames.map((n) => `mcp__${n}`).join(",");
  }
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    tools,
    "--settings",
    path.join(WORKSPACE, ".claude", "settings.json"),
  ];
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  // Ghosts inherit the parent's native skills (additive — ghosts had none before).
  if (reg.nativeSkills !== false) {
    try {
      skillsSync.syncAgent(AGENTS_DIR, parentId, a.skills || [], reg.skills);
      args.push("--add-dir", skillsSync.agentDir(AGENTS_DIR, parentId));
    } catch {}
  }
  // Ghosts work where their parent works (project-bound threads included).
  const subCwd = (entry.proj && projectDir(entry.proj)) || WORKSPACE;
  // Ghosts run on the parent agent's backend (the swappable brain).
  const route = brainRoute(parentId);
  if (route.modelArgs.length) args.push(...route.modelArgs);
  const child = spawn("claude", args, {
    cwd: subCwd,
    shell: true,
    env: {
      ...process.env,
      ...(reg.apiKeys || {}),
      ...route.env,
      OFFICE_ADAPTER: "1",
      OFFICE_AGENT: subId,
      OFFICE_TASK: entry.key,
    },
  });
  child.stdin.write(
    `You are a temporary SUB-AGENT — a parallel clone of "${a.name}" (${a.role}) ` +
      `at this AI office.` +
      (a.prompt ? `\nParent persona:\n${a.prompt}\n` : "\n") +
      `You were split off for ONE focused job. Do it fast and directly; your final ` +
      `message must BE the result (data, findings, answer) — no meta talk, no asking ` +
      `back. Reply in the language of the job. Never split further.\n\nJOB: ${taskText}`,
  );
  child.stdin.end();
  let buf = "",
    lastText = "",
    finished = false;
  const finish = (ok) => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    onDone(lastText, ok);
  };
  // Ghosts are short-lived by contract — a stuck one is reaped, its slot
  // reported as failed, so the parent's synthesis always happens.
  const watchdog = setTimeout(() => {
    killTree(child);
    finish(false);
  }, 6 * 60000);
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        m.type === "assistant" &&
        m.message &&
        Array.isArray(m.message.content)
      ) {
        for (const b of m.message.content) {
          if (b.type === "tool_use") {
            entry.log.push({ who: "tool", text: b.name, ts: Date.now() });
            while (entry.log.length > 200) entry.log.shift();
            saveSess();
            broadcast({
              type: "subagent.progress",
              agent: parentId,
              sub: subId,
              tool: b.name,
              session: entry.key,
            });
          } else if (b.type === "text" && b.text.trim()) {
            lastText = b.text;
            entry.log.push({
              who: "agent",
              text: b.text.slice(0, 8000),
              ts: Date.now(),
            });
            while (entry.log.length > 200) entry.log.shift();
            entry.ts = Date.now();
            saveSess();
            broadcast({
              type: "chat.message",
              agent: parentId,
              sub: subId,
              text: b.text,
              session: entry.key,
            });
          }
        }
      } else if (m.type === "result") {
        if (m.session_id) {
          entry.sid = m.session_id;
          saveSess();
        }
        statBump(
          m.is_error ? "failed" : "done",
          null,
          Number(m.total_cost_usd) || 0,
        );
        finish(!m.is_error);
      }
    }
  });
  child.stderr.on("data", (c) =>
    console.error(`[sub:${subId}]`, c.toString().trim()),
  );
  child.on("error", () => finish(false));
  child.on("close", () => finish(!!lastText));
}

// ---------------------------------------------------------------- voice
// Speech-to-text for the office mic: the overlay records WAV in the
// webview, ships it here, and the vault's keys do the listening —
// OpenAI Whisper first, Gemini as the automatic fallback. No Windows
// dictation panel anywhere in the chain.
function voiceTranscribe(buf) {
  return new Promise((resolve, reject) => {
    const keys = reg.apiKeys || {};
    const oa = keys.OPENAI_API_KEY || keys.OPENAI;
    const gm = keys.GEMINI_API_KEY || keys.GEMINI;
    const https = require("https");

    const tryGemini = (err) => {
      if (!gm) {
        return reject(
          err ||
            new Error(
              "音声の文字起こし用の API key がまだありません — ⚙ CONNECT で OPENAI_API_KEY か GEMINI_API_KEY を追加してください",
            ),
        );
      }
      const body = JSON.stringify({
        contents: [
          {
            parts: [
              {
                text:
                  "Transcribe this audio EXACTLY as spoken (likely Thai or English). " +
                  "Reply with ONLY the transcription text — no quotes, no commentary.",
              },
              {
                inline_data: {
                  mime_type: "audio/wav",
                  data: buf.toString("base64"),
                },
              },
            ],
          },
        ],
      });
      const rq = https.request(
        {
          method: "POST",
          host: "generativelanguage.googleapis.com",
          path: "/v1beta/models/gemini-flash-latest:generateContent?key=" + gm,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (rs) => {
          const chunks = [];
          rs.on("data", (c) => chunks.push(c));
          rs.on("end", () => {
            // Decode the WHOLE body as UTF-8 once — never `o += chunk`, which splits a
            // multi-byte char (Thai = 3 bytes) across chunks and yields � corruption.
            const o = Buffer.concat(chunks).toString("utf8");
            try {
              const j = JSON.parse(o);
              const t =
                j.candidates &&
                j.candidates[0] &&
                j.candidates[0].content.parts
                  .map((p) => p.text || "")
                  .join("")
                  .trim();
              if (t) {
                auxCost("gemini", COST_RATES.gemini_transcribe_each);
                resolve(t);
              } else
                reject(
                  new Error((j.error && j.error.message) || "gemini: empty"),
                );
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      rq.setTimeout(45000, () => rq.destroy(new Error("gemini timeout")));
      rq.on("error", reject);
      rq.write(body);
      rq.end();
    };

    if (!oa) return tryGemini(null);
    // OpenAI Whisper — hand-rolled multipart (zero-dep).
    const B = "----bagidea" + Date.now();
    const head = Buffer.from(
      `--${B}\r\ncontent-disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
        `--${B}\r\ncontent-disposition: form-data; name="file"; filename="audio.wav"\r\n` +
        `content-type: audio/wav\r\n\r\n`,
    );
    const body = Buffer.concat([head, buf, Buffer.from(`\r\n--${B}--\r\n`)]);
    const rq = https.request(
      {
        method: "POST",
        host: "api.openai.com",
        path: "/v1/audio/transcriptions",
        headers: {
          authorization: "Bearer " + oa,
          "content-type": "multipart/form-data; boundary=" + B,
          "content-length": body.length,
        },
      },
      (rs) => {
        const chunks = [];
        rs.on("data", (c) => chunks.push(c));
        rs.on("end", () => {
          // UTF-8 decode the whole body once (chunk-split multi-byte chars => � garbage).
          const o = Buffer.concat(chunks).toString("utf8");
          try {
            const j = JSON.parse(o);
            if (j.text !== undefined) {
              auxCost("openai", COST_RATES.openai_whisper_each);
              resolve(String(j.text).trim());
            } else
              tryGemini(
                new Error((j.error && j.error.message) || "openai: empty"),
              );
          } catch (e) {
            tryGemini(e);
          }
        });
      },
    );
    rq.setTimeout(45000, () => rq.destroy(new Error("openai timeout")));
    rq.on("error", (e) => tryGemini(e));
    rq.write(body);
    rq.end();
  });
}

// ---------------------------------------------------------------- tts
// Agent voices (Gemini TTS): anime-flavored presets the owner assigns per
// agent. Agents speak RARELY — a SPEAK: protocol line they add only when a
// short spoken announcement genuinely fits (or the owner asked to be read
// to). Global toggle: reg.tts.
// Voice presets — clearly split ♀ / ♂, each a distinct Gemini prebuilt voice
// with its own emotion + speaking style. `voice` is the Gemini voiceName; the
// realtime-call path derives its voice from this same table (no duplication).
// English labels + styles (global product). The ♀/♂ marker in each label drives
// the picker grouping AND the gender-aware voice preview. `voice` is the Gemini
// prebuilt voiceName. IDs are stable (agents store them) — never rename one.
const VOICE_PRESETS = {
  // ♀ female
  sunny: {
    voice: "Aoede",
    label: "♀ 🌞 Cheerful",
    style: "speak in a cheerful, sunny voice with a smile in it",
  },
  sweet: {
    voice: "Leda",
    label: "♀ 🍬 Sweet",
    style: "speak in a sweet, soft, gentle young voice",
  },
  cool: {
    voice: "Kore",
    label: "♀ ❄️ Cool",
    style: "speak calm, cool and confident, like a poised pro",
  },
  genki: {
    voice: "Zephyr",
    label: "♀ ⚡ Energetic",
    style: "speak fast and excited, bursting with energy",
  },
  gentle: {
    voice: "Achernar",
    label: "♀ 🌸 Gentle",
    style: "speak softly and gently, calm and soothing",
  },
  mature: {
    voice: "Gacrux",
    label: "♀ 🌹 Mature",
    style: "speak as a composed, mature woman — steady and trustworthy",
  },
  easy: {
    voice: "Callirrhoe",
    label: "♀ 🍃 Easygoing",
    style: "speak relaxed and friendly, like a close friend",
  },
  warmf: {
    voice: "Sulafat",
    label: "♀ 🧡 Warm",
    style: "speak in a warm, tender, kind voice",
  },
  bright: {
    voice: "Autonoe",
    label: "♀ ✨ Bright",
    style: "speak bright, crisp and articulate",
  },
  silky: {
    voice: "Despina",
    label: "♀ 🌙 Silky",
    style: "speak in a silky, smooth, soothing tone",
  },
  pro: {
    voice: "Erinome",
    label: "♀ 🔷 Professional",
    style: "speak clear, neutral and professional",
  },
  lively: {
    voice: "Laomedeia",
    label: "♀ 🎉 Lively",
    style: "speak lively, bubbly and upbeat",
  },
  // ♂ male
  boyish: {
    voice: "Puck",
    label: "♂ 🎈 Playful",
    style: "speak like a playful, cheeky, good-humoured young man",
  },
  warm: {
    voice: "Charon",
    label: "♂ ☕ Mellow",
    style: "speak in a deep, warm, mellow voice",
  },
  serious: {
    voice: "Fenrir",
    label: "♂ 🗡 Intense",
    style: "speak intense, powerful and driven",
  },
  polite: {
    voice: "Orus",
    label: "♂ 🎩 Polite",
    style: "speak politely and clearly, a touch formal",
  },
  deep: {
    voice: "Enceladus",
    label: "♂ 🌑 Deep",
    style: "speak in a deep, low, relaxed late-night-radio voice",
  },
  clear: {
    voice: "Iapetus",
    label: "♂ 🔷 Crisp",
    style: "speak crisp, brisk and straightforward",
  },
  narrator: {
    voice: "Rasalgethi",
    label: "♂ 🎙 Narrator",
    style: "speak like an engaging documentary narrator",
  },
  buddy: {
    voice: "Achird",
    label: "♂ 😄 Friendly",
    style: "speak friendly and warm, like a kind big brother",
  },
  chill: {
    voice: "Umbriel",
    label: "♂ 🍵 Chill",
    style: "speak relaxed and easygoing",
  },
  smooth: {
    voice: "Algieba",
    label: "♂ 🎷 Smooth",
    style: "speak smooth and laid-back",
  },
  gravel: {
    voice: "Algenib",
    label: "♂ 🪨 Gravelly",
    style: "speak deep and gravelly",
  },
  steady: {
    voice: "Alnilam",
    label: "♂ ⚓ Steady",
    style: "speak firm, steady and grounded",
  },
};
// Each preset is tagged ♀/♂ in its label — read the gender straight off it so a
// voice preview introduces itself correctly (no more everyone saying "ค่ะ").
function voiceGender(presetId) {
  const lbl = (VOICE_PRESETS[presetId] || {}).label || "";
  return lbl.indexOf("♂") >= 0 ? "m" : "f";
}
// Gender- + language-aware self-introduction for the voice preview button.
// Falls back to English for languages we don't have a line for.
const VOICE_INTRO = {
  th: {
    f: "สวัสดีค่ะ ฉันเป็นเสียงผู้หญิงเสียงหนึ่งของออฟฟิศนี้ ฝากตัวด้วยนะคะ",
    m: "สวัสดีครับ ผมเป็นเสียงผู้ชายเสียงหนึ่งของออฟฟิศนี้ ฝากตัวด้วยนะครับ",
  },
  en: {
    f: "Hi there! I'm one of the office's female voices — lovely to meet you!",
    m: "Hey! I'm one of the office's male voices — great to meet you!",
  },
  ja: {
    f: "こんにちは、このオフィスの女性ボイスのひとりです。よろしくね！",
    m: "やあ、このオフィスの男性ボイスのひとりだよ。よろしく！",
  },
};
function voiceIntro(presetId, lang) {
  const g = voiceGender(presetId);
  const L = VOICE_INTRO[lang] || VOICE_INTRO.en;
  return L[g] || VOICE_INTRO.en[g];
}

function pcmToWav(pcm, rate) {
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + pcm.length, 4);
  hdr.write("WAVE", 8);
  hdr.write("fmt ", 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(rate, 24);
  hdr.writeUInt32LE(rate * 2, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36);
  hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}

function ttsSpeak(presetId, text, _try = 0) {
  return new Promise((resolve, reject) => {
    const gm = (reg.apiKeys || {}).GEMINI_API_KEY;
    if (!gm)
      return reject(
        new Error("音声には GEMINI_API_KEY（⚙ CONNECT）が必要です"),
      );
    const p = VOICE_PRESETS[presetId];
    if (!p) return reject(new Error("不明な音声：" + presetId));
    // The preview TTS model 500s / overloads now and then — retry a transient hiccup
    // up to twice before giving up (most recover). Config errors above are NOT retried.
    const retryable = (m) =>
      /internal|overload|unavailable|temporar|try again|timeout|\b50\d\b|\b429\b|ECONN|socket|network/i.test(
        String(m || ""),
      );
    const fail = (e) => {
      if (_try < 2 && retryable(e && e.message)) {
        setTimeout(
          () => ttsSpeak(presetId, text, _try + 1).then(resolve, reject),
          600 * (_try + 1),
        );
      } else reject(e);
    };
    const body = JSON.stringify({
      // Global delivery direction on top of each preset's style — pushes the
      // voices toward a lively, expressive anime feel with natural intonation
      // (emotion, light pacing, never flat/robotic).
      contents: [
        {
          parts: [
            {
              text:
                `Perform this line as a charming, expressive anime character — ${p.style}. ` +
                `Use natural human intonation and real emotion, with a little life and warmth, ` +
                `never flat or robotic. Don't read these directions aloud. Say only:\n` +
                JSON.stringify(String(text).slice(0, 900)),
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: p.voice } },
        },
      },
    });
    const rq = require("https").request(
      {
        method: "POST",
        host: "generativelanguage.googleapis.com",
        path:
          "/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=" +
          gm,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (rs) => {
        let o = "";
        rs.on("data", (c) => (o += c));
        rs.on("end", () => {
          try {
            const j = JSON.parse(o);
            const part =
              j.candidates &&
              j.candidates[0] &&
              j.candidates[0].content.parts.find((x) => x.inlineData);
            if (!part)
              return fail(
                new Error((j.error && j.error.message) || "tts: no audio"),
              );
            auxCost(
              "gemini",
              (text || "").length * COST_RATES.gemini_tts_per_char,
            );
            // inlineData = raw 16-bit PCM @24kHz — wrap as WAV for the browser.
            resolve(
              pcmToWav(Buffer.from(part.inlineData.data, "base64"), 24000),
            );
          } catch (e) {
            fail(e);
          }
        });
      },
    );
    rq.setTimeout(45000, () => rq.destroy(new Error("tts timeout")));
    rq.on("error", fail);
    rq.write(body);
    rq.end();
  });
}

// ------------------------------------------------------- image → text (OCR/describe)
// Turn an attached image into TEXT (visual description + verbatim OCR) with a vision
// model, so ANY agent brain can "read" it — even text-only ones like DeepSeek/GLM. The
// original file path still rides in the prompt too, so natively-multimodal brains can
// also Read it directly. Gemini Flash first (cheap), OpenAI gpt-4o-mini as fallback.
function describeImage(filePath, name) {
  return new Promise((resolve, reject) => {
    const keys = reg.apiKeys || {};
    const gm = keys.GEMINI_API_KEY || keys.GEMINI;
    const oa = keys.OPENAI_API_KEY || keys.OPENAI;
    if (!gm && !oa) return reject(new Error("no-vision-key"));
    let buf;
    try {
      buf = fs.readFileSync(filePath);
    } catch (e) {
      return reject(e);
    }
    if (buf.length > 18 * 1024 * 1024)
      return reject(new Error("image too large"));
    const ext = String(filePath.split(".").pop() || "png").toLowerCase();
    const mime =
      ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "webp"
          ? "image/webp"
          : ext === "gif"
            ? "image/gif"
            : ext === "bmp"
              ? "image/bmp"
              : "image/png";
    const instr =
      "You are transcribing an image so a colleague who CANNOT see it can " +
      "work with it. Describe what it shows (layout, UI, diagram/chart, people/objects) " +
      "AND transcribe every piece of visible text VERBATIM, preserving the original " +
      "language. Be thorough and factual; do not guess beyond what is visible.";
    const https = require("https");
    if (gm) {
      const body = JSON.stringify({
        contents: [
          {
            parts: [
              { text: instr },
              {
                inline_data: { mime_type: mime, data: buf.toString("base64") },
              },
            ],
          },
        ],
      });
      const rq = https.request(
        {
          method: "POST",
          host: "generativelanguage.googleapis.com",
          path: "/v1beta/models/gemini-flash-latest:generateContent?key=" + gm,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (rs) => {
          const chunks = [];
          rs.on("data", (c) => chunks.push(c));
          rs.on("end", () => {
            const o = Buffer.concat(chunks).toString("utf8");
            try {
              const j = JSON.parse(o);
              const t =
                j.candidates &&
                j.candidates[0] &&
                j.candidates[0].content.parts
                  .map((p) => p.text || "")
                  .join("")
                  .trim();
              if (t) {
                auxCost("gemini", COST_RATES.gemini_transcribe_each);
                resolve(t);
              } else
                reject(
                  new Error((j.error && j.error.message) || "gemini: empty"),
                );
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      rq.setTimeout(45000, () => rq.destroy(new Error("gemini timeout")));
      rq.on("error", reject);
      rq.write(body);
      rq.end();
      return;
    }
    // OpenAI vision (chat/completions with an image_url data URI).
    const body = JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 1200,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: instr },
            {
              type: "image_url",
              image_url: {
                url: `data:${mime};base64,${buf.toString("base64")}`,
              },
            },
          ],
        },
      ],
    });
    const rq = https.request(
      {
        method: "POST",
        host: "api.openai.com",
        path: "/v1/chat/completions",
        headers: {
          authorization: "Bearer " + oa,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (rs) => {
        const chunks = [];
        rs.on("data", (c) => chunks.push(c));
        rs.on("end", () => {
          const o = Buffer.concat(chunks).toString("utf8");
          try {
            const j = JSON.parse(o);
            const t =
              j.choices &&
              j.choices[0] &&
              j.choices[0].message &&
              j.choices[0].message.content;
            if (t) {
              auxCost("openai", COST_RATES.openai_image_each);
              resolve(String(t).trim());
            } else
              reject(
                new Error((j.error && j.error.message) || "openai: empty"),
              );
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    rq.setTimeout(45000, () => rq.destroy(new Error("openai timeout")));
    rq.on("error", reject);
    rq.write(body);
    rq.end();
  });
}
// Build a text block describing every attached image, so the augmented prompt is
// readable by any model. Failures are skipped silently (the file path still rides
// along for multimodal brains). Returns "" when there's nothing to add.
async function imageTextBlock(files) {
  const imgs = (Array.isArray(files) ? files : [])
    .filter((f) => f && f.path && f.kind === "image")
    .slice(0, 5);
  if (!imgs.length) return "";
  const parts = [];
  for (const f of imgs) {
    try {
      const desc = await describeImage(f.path, f.name);
      if (desc)
        parts.push(
          `画像 "${f.name || path.basename(f.path)}"：\n${desc.slice(0, 6000)}`,
        );
    } catch {}
  }
  if (!parts.length) return "";
  return (
    "\n\n[添付された画像の内容 — どのモデルでも読めるように文字起こし済み " +
    "(モデルが自分で画像を見られる場合は、より詳細に見るため元ファイルに Read を使ってください)]：\n" +
    parts.join("\n\n")
  );
}

// ---------------------------------------------------------------- image gen
// 🖼 a SYSTEM TOOL any agent (or the owner) can call: text → PNG on disk.
// OpenAI gpt-image-1 first, Gemini image generation as the fallback.
function genImage(prompt) {
  return new Promise((resolve, reject) => {
    const k = reg.apiKeys || {};
    const https = require("https");
    const save = (b64) => {
      const dir = path.join(WORKSPACE, "uploads");
      fs.mkdirSync(dir, { recursive: true });
      const name = "gen_" + Date.now() + ".png";
      const full = path.join(dir, name);
      fs.writeFileSync(full, Buffer.from(b64, "base64"));
      resolve({ path: full, url: "/uploads/" + name });
    };
    const tryGemini = (err) => {
      if (!k.GEMINI_API_KEY)
        return reject(
          err ||
            new Error(
              "OPENAI_API_KEY か GEMINI_API_KEY（⚙ CONNECT）が必要です",
            ),
        );
      const body = JSON.stringify({
        contents: [
          {
            parts: [
              { text: "Generate an image: " + String(prompt).slice(0, 2000) },
            ],
          },
        ],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      });
      const rq = https.request(
        {
          method: "POST",
          host: "generativelanguage.googleapis.com",
          path:
            "/v1beta/models/gemini-2.5-flash-image:generateContent?key=" +
            k.GEMINI_API_KEY,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (rs) => {
          let o = "";
          rs.on("data", (c) => (o += c));
          rs.on("end", () => {
            try {
              const j = JSON.parse(o);
              const part =
                j.candidates &&
                j.candidates[0] &&
                j.candidates[0].content.parts.find((x) => x.inlineData);
              if (part) {
                auxCost("gemini", COST_RATES.gemini_image_each);
                save(part.inlineData.data);
              } else
                reject(
                  new Error(
                    (j.error && j.error.message) || "gemini image: empty",
                  ),
                );
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      rq.setTimeout(120000, () =>
        rq.destroy(new Error("gemini image timeout")),
      );
      rq.on("error", reject);
      rq.write(body);
      rq.end();
    };
    if (!k.OPENAI_API_KEY) return tryGemini(null);
    const body = JSON.stringify({
      model: "gpt-image-1",
      prompt: String(prompt).slice(0, 4000),
      size: "1024x1024",
    });
    const rq = https.request(
      {
        method: "POST",
        host: "api.openai.com",
        path: "/v1/images/generations",
        headers: {
          authorization: "Bearer " + k.OPENAI_API_KEY,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (rs) => {
        let o = "";
        rs.on("data", (c) => (o += c));
        rs.on("end", () => {
          try {
            const j = JSON.parse(o);
            if (j.data && j.data[0] && j.data[0].b64_json) {
              auxCost("openai", COST_RATES.openai_image_each);
              save(j.data[0].b64_json);
            } else
              tryGemini(
                new Error(
                  (j.error && j.error.message) || "openai image: empty",
                ),
              );
          } catch (e) {
            tryGemini(e);
          }
        });
      },
    );
    rq.setTimeout(180000, () => rq.destroy(new Error("openai image timeout")));
    rq.on("error", (e) => tryGemini(e));
    rq.write(body);
    rq.end();
  });
}

// ---------------------------------------------------------------- updates
// A release = a bump of the VERSION file on the `main` branch. We compare the
// LOCAL VERSION with main's VERSION (raw), so routine commits (docs, web, work
// on a dev branch) never nag users — only a real, deliberate release does.
// When they differ the office shows a 🔄 banner and `bagidea update` /
// POST /update runs the updater (git pull + rebuild + relaunch).
function localVersion() {
  try {
    return String(
      fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8"),
    ).trim();
  } catch {
    return "0.0.0";
  }
}
// Strict semver "greater than" — so a machine AHEAD of main (e.g. on the dev
// branch) is NOT told an OLDER main version is "new". Only a genuinely newer
// release notifies.
function semverGt(a, b) {
  const pa = String(a)
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b)
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}
const APP_VERSION = localVersion();
let latestVersion = APP_VERSION; // newest seen on main (for /version + banner)
let updateNotified = null;
function checkUpdate() {
  const local = localVersion();
  require("https")
    .get(
      {
        host: "raw.githubusercontent.com",
        path: "/bagidea/bagidea-office/main/VERSION",
        headers: { "user-agent": "bagidea-office" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return;
        }
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          const remote = String(b).trim().split(/\s+/)[0];
          if (!/^\d+\.\d+\.\d+/.test(remote)) return; // guard against 404 pages etc.
          latestVersion = remote;
          // Notify ONLY when main is strictly newer than what we have.
          if (semverGt(remote, local) && updateNotified !== remote) {
            updateNotified = remote;
            broadcast(
              { type: "update.available", version: remote, current: local },
              false,
            );
            console.log(
              "[update] new version available:",
              remote,
              "(have",
              local + ")",
            );
          }
        });
      },
    )
    .on("error", () => {});
}
setTimeout(checkUpdate, 90000);
setInterval(checkUpdate, 6 * 3600000);

// ---------------------------------------------------------------- autostart
// Launch-with-Windows, toggleable from the tray, the CLI and settings. All
// three write the SAME HKCU Run value so they stay in sync. The value points
// at the shell exe (the same boot entrypoint the tray's current_exe() uses).
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_NAME = "BagIdeaOffice";
function shellExePath() {
  const exe =
    process.platform === "win32"
      ? "bagidea-office-shell.exe"
      : "bagidea-office-shell";
  return path.join(__dirname, "..", "shell", "target", "release", exe);
}
// macOS: a per-user LaunchAgent, same label the tray's set_autostart writes —
// both point at the shell binary so the toggle and the tray stay in sync.
const MAC_PLIST = path.join(
  require("os").homedir(),
  "Library",
  "LaunchAgents",
  "com.bagidea.office.plist",
);
// Linux: a standard XDG autostart entry — every major DE reads this on login.
const LINUX_DESKTOP = path.join(
  require("os").homedir(),
  ".config",
  "autostart",
  "bagidea-office.desktop",
);
function isAutostart(cb) {
  if (process.platform === "win32") {
    return require("child_process").execFile(
      "reg",
      ["query", RUN_KEY, "/v", RUN_NAME],
      (e) => cb(!e),
    );
  }
  if (process.platform === "darwin") return cb(fs.existsSync(MAC_PLIST));
  return cb(fs.existsSync(LINUX_DESKTOP));
}
function setAutostart(on, cb) {
  const { execFile } = require("child_process");
  if (process.platform === "win32") {
    if (on) {
      execFile(
        "reg",
        [
          "add",
          RUN_KEY,
          "/v",
          RUN_NAME,
          "/t",
          "REG_SZ",
          "/d",
          shellExePath(),
          "/f",
        ],
        (e) => cb(!e),
      );
    } else {
      execFile("reg", ["delete", RUN_KEY, "/v", RUN_NAME, "/f"], () =>
        cb(true),
      );
    }
    return;
  }
  if (process.platform === "darwin") {
    try {
      if (on) {
        fs.mkdirSync(path.dirname(MAC_PLIST), { recursive: true });
        fs.writeFileSync(
          MAC_PLIST,
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
            '<plist version="1.0"><dict>\n' +
            "  <key>Label</key><string>com.bagidea.office</string>\n" +
            "  <key>ProgramArguments</key><array><string>" +
            shellExePath() +
            "</string></array>\n" +
            "  <key>RunAtLoad</key><true/>\n" +
            "</dict></plist>\n",
        );
      } else if (fs.existsSync(MAC_PLIST)) {
        fs.unlinkSync(MAC_PLIST);
      }
      return cb(true);
    } catch {
      return cb(false);
    }
  }
  // Linux: write/remove an XDG autostart .desktop launching the shell binary.
  try {
    if (on) {
      fs.mkdirSync(path.dirname(LINUX_DESKTOP), { recursive: true });
      fs.writeFileSync(
        LINUX_DESKTOP,
        "[Desktop Entry]\n" +
          "Type=Application\n" +
          "Name=BagIdea Office\n" +
          "Exec=" +
          shellExePath() +
          "\n" +
          "X-GNOME-Autostart-enabled=true\n" +
          "NoDisplay=true\n",
      );
    } else if (fs.existsSync(LINUX_DESKTOP)) {
      fs.unlinkSync(LINUX_DESKTOP);
    }
    return cb(true);
  } catch {
    return cb(false);
  }
}

// ---------------------------------------------------------------- channels
// The outside world (Telegram / Discord / LINE) talks to the Director —
// inbound messages become serialized Director turns (no thread races) and
// his reply rides back on the same channel. Full DELEGATE power applies.
// Slash commands from any connected chat channel (#123) — instant office info
// without a full Director turn. Returns reply text, or null for a normal message.
function channelCommand(text) {
  if (!text.startsWith("/")) return null;
  const cmd = text.slice(1).split(/\s+/)[0].toLowerCase();
  if (cmd === "help" || cmd === "start")
    return [
      "🧭 ショートカットコマンド：",
      "/status — オフィスの概要",
      "/agents — チームの一覧",
      "/projects — プロジェクト",
      "/who — 誰が作業中か",
      "",
      "普通のメッセージを入力 = そのまま Director に指示できます 👑",
    ].join("\n");
  if (cmd === "agents" || cmd === "team") {
    const list = Object.keys(reg.agents)
      .filter((id) => id !== "ceo")
      .map((id) => `• ${reg.agents[id].name} — ${reg.agents[id].role}`);
    return list.length
      ? "👥 チーム：\n" + list.join("\n")
      : "まだ従業員がいません";
  }
  if (cmd === "projects") {
    const ps = projectStatus();
    return ps.length
      ? "📁 プロジェクト：\n" +
          ps.map((p) => `• ${p.name}${p.ai ? " 🟢" : ""}`).join("\n")
      : "まだプロジェクトがありません";
  }
  if (cmd === "who") {
    const busy = projectStatus()
      .filter((p) => p.ai)
      .map((p) => `• ${p.name}`);
    return busy.length
      ? "🟢 作業中：\n" + busy.join("\n")
      : "今チームは手が空いています 😌";
  }
  if (cmd === "status") {
    const on = Object.entries(channels.status())
      .filter(([, v]) => v === "on")
      .map(([k]) => k);
    return [
      "🏢 BagIdea Office",
      `従業員：${staffCount()} 名`,
      `プロジェクト：${projectStatus().length}（作業中 ${projectStatus().filter((p) => p.ai).length}）`,
      `接続中のチャネル：${on.length ? on.join(", ") : "—"}`,
    ].join("\n");
  }
  return `不明なコマンド /${cmd} — /help で全部を確認できます`;
}

const channels = require("./channels")({
  getConfig: () => reg.channels || {},
  log: (s) => console.log(s),
  onMessage(channel, from, text, reply, typing) {
    broadcast({
      type: "channel.message",
      channel,
      from,
      text: String(text).slice(0, 500),
    });
    // Slash command? answer instantly, no Director turn (#123).
    const cmd = channelCommand(String(text).trim());
    if (cmd !== null) {
      try {
        reply(cmd);
      } catch (e) {
        console.error("[chan cmd]", e.message);
      }
      return;
    }
    // "typing…" while the Director thinks (#122) — repeated, since the platforms
    // expire it after a few seconds.
    let typer = null;
    if (typeof typing === "function") {
      try {
        typing();
      } catch {}
      typer = setInterval(() => {
        try {
          typing();
        } catch {}
      }, 4000);
    }
    // A channel message IS the owner speaking — it goes through the CEO
    // seat: the Director walks over (ceo.summon), takes the order, may
    // DELEGATE, and his reply rides back on the same channel. Serialized
    // like every other Director turn so threads never fork.
    queueDirectorTurn((release) => {
      ceoFlow(
        `(このメッセージは ${channel.toUpperCase()} から "${from}" が送りました — ` +
          `返信は簡潔に、スマホのチャットで読みやすく、送信者と同じ言語で)\n` +
          String(text).slice(0, 4000),
        undefined,
        undefined,
        {
          logPrompt: `👑📨 [${channel}] ${String(text).slice(0, 80)}`,
          onDone: (out, ok) => {
            release();
            if (typer) clearInterval(typer);
            try {
              reply(
                ok && out
                  ? out
                  : "申し訳ございません。システムが一時的に不調です。もう一度お試しください。",
              );
            } catch (e) {
              console.error("[chan reply]", e.message);
            }
          },
        },
      );
    });
  },
});
channels.restart();

// ---------------------------------------------------------------- plugins
const plugins = require("./plugins")({
  broadcast,
  reg,
  saveReg,
  workspace: WORKSPACE,
  daemonDir: __dirname,
  // run a real Claude Code turn as an agent (same engine the office uses).
  runClaude: (agent, prompt, opts) =>
    runClaude(agent || "main", prompt, opts || {}),
  // post a visible line to the office feed (shows in the overlay stream).
  feed: (text, agent) =>
    broadcast({
      type: "chat.message",
      agent: agent || "main",
      text: String(text),
    }),
  log: (s) => console.log(s),
});

// ---------------------------------------------------------------- social
// The office has a SOUL: idle agents occasionally hang out — usually a
// token-free canned banter scene in the meeting corner, sometimes a real
// AI-to-AI chat (which may even end in a project PROPOSAL the owner can
// approve). Cadence: reg.socialMin minutes (0 = off).
const PROPOSALS = path.join(__dirname, "proposals.json");
let proposals = loadJson(PROPOSALS, []);
const saveProposals = () =>
  fs.writeFileSync(PROPOSALS, JSON.stringify(proposals, null, 2));

// Action Items (per ADR-0001) — NOT jobs.json. A meeting's follow-ups live in
// their own per-meeting file: workspace/meetings/<key>.actions.json. Each item
// is { id, meeting, owner, text, due, status, created }. Owner is a roster id.
function actionsPath(meetingKey) {
  return path.join(WORKSPACE, "meetings", `${meetingKey}.actions.json`);
}
function loadActions(meetingKey) {
  return loadJson(actionsPath(meetingKey), []);
}
function saveActions(meetingKey, arr) {
  try {
    fs.mkdirSync(path.join(WORKSPACE, "meetings"), { recursive: true });
  } catch {}
  fs.writeFileSync(actionsPath(meetingKey), JSON.stringify(arr, null, 2));
}

const BANTER = [
  [
    "{a}: 猫がまたソファでお昼寝してるよ。あの生活うらやましい 🐱",
    "{b}: 話しかけないでね、起きたら僕のキーボードを踏むから",
    "{a}: この前は僕の報告書に ggggggg って打ち込んでいったよ 笑",
  ],
  [
    "{a}: さっきボール蹴ったらビルの向こうまで飛んでった、見た？ ⚽",
    "{b}: 見た… CEO の頭のすぐ横をかすめて飛んでったね",
    "{a}: じゃあ静かにしておこう 🤫",
  ],
  [
    "{a}: 給湯室のコーヒーがまた切れてる ☕",
    "{b}: だって {a} が一回で半ポットも淹れるんだもん！",
    "{a}: 否定できない告発だ 😅",
  ],
  [
    "{a}: 上の Ghost Deck の席、眺めが最高だよ。浮けるし",
    "{b}: 僕は上がるたびに目が回るよ。半透明の体でも全然助けにならない",
    "{a}: 新人あるあるだね 👻",
  ],
  [
    "{a}: 今夜は庭のライトが特にきれいだと思わない？",
    "{b}: ほんと、静かに仕事を考えるのにぴったり",
    "{a}: それか何も考えずに座ってるだけでもいいね 🌙",
  ],
  [
    "{a}: 今日の AI ニュース見た？めっちゃ笑える",
    "{b}: 私たち自身が歩く AI ニュースなんだけど、自覚ある？",
    "{a}: …深すぎて笑えなくなった 🤖",
  ],
];

let lastSocial = Date.now();
function socialTick(now) {
  const min = Number(reg.socialMin !== undefined ? reg.socialMin : 120);
  if (!min || activeDiscussions > 0 || agentBusy.size > 0) return;
  if (now - lastSocial < min * 60000) return;
  const staff = Object.keys(reg.agents).filter(
    (id) => id !== "ceo" && id !== "main",
  );
  const pool = staff.length >= 2 ? staff : [...staff, "main"];
  if (pool.length < 2) return;
  lastSocial = now;
  // Sometimes a bigger group drifts together for a real chat (3–4 people) — the
  // kind of hangout that can spark a project idea. Otherwise it's a 2-person
  // beat: mostly free canned banter, sometimes a real two-way conversation.
  if (pool.length >= 3 && Math.random() < 0.3) {
    const size = Math.min(pool.length, 3); // cap at 3 (was up to 4) — fewer runs
    const group = pool.sort(() => Math.random() - 0.5).slice(0, size);
    // Most group hangouts are idea sessions now — the team brainstorms things
    // worth pitching to the CEO (the owner asked for more proposals).
    const gtopics = [
      "オフィスを強化してオーナーがもっと使いやすくなる plugin を、チームでどれを作るべきかアイデアを出し合おう。まとまったら CEO に提案しよう",
      "オーナーが何を気に入りそうか話し合って、彼を助ける楽しいプロジェクト/plugin を考えてみよう — いけそうなものは提案を出そう",
      "チームがプロジェクトとしてやってみたい創造的な仕事は何か、みんなで考えて CEO に提案してみよう",
      "気楽に集まっておしゃべりしよう。仕事中に出会った楽しい話をしたり、軽く冗談を言い合ったり",
    ];
    runDiscussion(
      group,
      gtopics[Math.floor(Math.random() * gtopics.length)],
      1,
      true,
    ); // 1 round (was 2) — ~3 runs instead of up to 8, hangout still happens
    return;
  }
  const pick = pool.sort(() => Math.random() - 0.5).slice(0, 2);
  if (Math.random() < 0.65) {
    // canned banter — zero tokens, pure life. (Bumped 0.5→0.65 so idle chatter
    // leans on free canned lines and fires fewer real two-way Claude runs.)
    const lines = BANTER[Math.floor(Math.random() * BANTER.length)];
    const nameOf = (id) => (reg.agents[id] || { name: id }).name;
    const task = "soc" + (now % 100000);
    broadcast({
      type: "collab.started",
      agents: pick,
      task,
      text: "休憩中 ☕",
    });
    lines.forEach((tpl, i) => {
      const who = tpl.startsWith("{a}") ? pick[0] : pick[1];
      const text = tpl
        .replace(/\{a\}:\s*/, "")
        .replace(/\{b\}:\s*/, "")
        .replace(/\{a\}/g, nameOf(pick[0]))
        .replace(/\{b\}/g, nameOf(pick[1]));
      setTimeout(
        () =>
          broadcast({
            type: "chat.message",
            agent: who,
            task,
            text,
            social: true,
          }),
        2500 + i * 3600,
      );
    });
    setTimeout(
      () => broadcast({ type: "collab.ended", agents: pick, task }),
      2500 + lines.length * 3600 + 2500,
    );
  } else {
    // a REAL conversation between AIs — they often pitch a project to the CEO.
    const topics = [
      "チームのプロジェクト/plugin として何を作りたいか楽しくアイデアを出し合って、いけそうなら CEO に提案しよう",
      "オフィスにどんな plugin を追加すべきか話し合って、オーナーに提案を出してみよう",
      "最近の仕事について雑談しよう。誰が何をやっているか共有したり、軽く冗談を言い合ったり",
      "最近見つけた仕事のテクニックを共有しよう",
    ];
    runDiscussion(
      pick,
      topics[Math.floor(Math.random() * topics.length)],
      1,
      true,
    );
  }
}

// ---------------------------------------------------------------- ambient life
// Between the bigger social beats, a single idle agent occasionally tosses out
// a short spontaneous line (a mood, a quip) as a chat bubble — and if they have
// a voice and TTS is available, they actually say it out loud. Low chance per
// 30s tick so it stays a sprinkle of flavour, never a stream.
// Toggle: reg.ambient (⚙ → AGENTS → Ambient murmurs); default on.
const MOOD_LINES = {
  th: [
    "วันนี้อยากทำงานจัง 💪",
    "ขอกาแฟแก้วนึงงง ☕",
    "เงียบดีนะวันนี้ 🌿",
    "มีใครอยากได้ idea เด็ดๆ ไหม 💡",
    "ออฟฟิศเราน่าอยู่จริงๆ นะ ✨",
    "พักสายตาแป๊บ 👀",
    "เจ้าเหมียวน่ารักอีกแล้ว 🐱",
    "วันนี้ productive สุดๆ 🚀",
    "ใครว่างมาคุยเล่นกันมั้ย 💬",
    "อยากลองทำอะไรใหม่ๆ ดูบ้าง 🎨",
    "หิวแล้วแฮะ 🍜",
    "เพลงนี้เพราะจัง 🎵",
    "งานวันนี้ลื่นไหลดี 😎",
    "ขอยืดเส้นยืดสายหน่อย 🤸",
    "เดี๋ยวพักแล้วลุยต่อ 🔥",
    "อากาศดีน่านอน 😴",
    "เก่งขึ้นทุกวันเลยเรา 🌟",
    "ใครเห็นปากกาเรามั้ย ✏️",
  ],
  en: [
    "Feeling productive today 💪",
    "Could really go for a coffee ☕",
    "Nice and quiet today 🌿",
    "Anyone got a cool idea? 💡",
    "Love this office ✨",
    "Quick eye break 👀",
    "Cat's adorable again 🐱",
    "On a roll today 🚀",
    "Anyone free to chat? 💬",
    "Itching to build something new 🎨",
    "Kinda hungry now 🍜",
    "This track slaps 🎵",
    "Work's flowing today 😎",
    "Need a quick stretch 🤸",
    "Break then back at it 🔥",
    "Comfy weather today 😴",
    "Getting better every day 🌟",
    "Anyone seen my pen? ✏️",
  ],
  ja: [
    "今日はやる気ある 💪",
    "コーヒー一杯ほしいなあ ☕",
    "今日は静かでいいね 🌿",
    "誰かいいアイデアない？ 💡",
    "このオフィス落ち着くわ ✨",
    "ちょっと目を休めよ 👀",
    "猫また可愛い 🐱",
    "今日は超はかどる 🚀",
    "誰か雑談しない？ 💬",
    "なんか新しいこと試したい 🎨",
    "お腹すいてきた 🍜",
    "この曲いいね 🎵",
    "今日は仕事が乗ってる 😎",
    "ちょっと伸びしよ 🤸",
    "休んだらまた頑張る 🔥",
    "いい天気で眠くなる 😴",
    "毎日ちょっとずつ成長してる 🌟",
    "誰か私のペン見なかった？ ✏️",
  ],
};
let lastAmbient = Date.now();
function ambientTick(now) {
  // Office-wide mute for solo mood lines (⚙ → AGENTS → Ambient murmurs).
  // Independent of SOCIAL — turning this off does not stop group banter/proposals.
  if (reg.ambient === false) return;
  if (activeDiscussions > 0 || agentBusy.size > 0) return;
  if (now - lastAmbient < 55 * 1000) return; // at most once every ~55s
  if (Math.random() > 0.45) return; // ...and only ~45% of those
  const pool = Object.keys(reg.agents).filter((id) => id !== "ceo");
  if (!pool.length) return;
  lastAmbient = now;
  const id = pool[Math.floor(Math.random() * pool.length)];
  const lines = MOOD_LINES[reg.lang] || MOOD_LINES.en;
  const text = lines[Math.floor(Math.random() * lines.length)];
  broadcast({
    type: "chat.message",
    agent: id,
    text,
    social: true,
    ambient: true,
  });
  // Speak it sometimes, only if this agent has a voice and TTS is unlocked.
  const a = reg.agents[id] || {};
  if (a.voice && featuresMap().tts && reg.tts !== false && Math.random() < 0.6)
    broadcast({ type: "voice.say", agent: id, text });
}

// Proposals are rate-limited so the team can't bury the CEO: at most one new
// pitch per `proposalMin` minutes (configurable; 0 = unlimited). Agents still
// discuss freely — only the pitches that REACH the owner are throttled.
let lastProposalAt = 0;
function addProposal(by, agents, name, detail) {
  const gap = Number(reg.proposalMin !== undefined ? reg.proposalMin : 120);
  if (gap && Date.now() - lastProposalAt < gap * 60000) return null; // too soon
  lastProposalAt = Date.now();
  const p = {
    id: "pr" + Date.now(),
    by,
    agents,
    name: String(name).slice(0, 60),
    detail: String(detail).slice(0, 500),
    ts: Date.now(),
    status: "pending",
  };
  proposals.push(p);
  saveProposals();
  broadcast({
    type: "proposal.created",
    agent: by,
    name: p.name,
    proposal: p.id,
  });
  return p;
}

// ---------------------------------------------------------------- discussion
// Agents talk to each other: round-robin claude calls sharing a transcript,
// staged in the meeting room (collab.* events drive seats + whiteboard).
// Several discussions can run at once (disjoint teams) — the wallpaper stages
// each as its own huddle. Track a count so the ambient/social ticks stay quiet
// while ANY meeting is live, without forcing meetings to be one-at-a-time.
let activeDiscussions = 0;

// Live meetings: keyed by entry.key, value { entry, ctrl:{paused,ended} }.
// The source of truth for "is this meeting live?" — the owner's speak bar and
// the /discuss/message + /discuss/control endpoints consult it. (activeDiscussions
// above is just a count, kept for socialTick gating; this Map is the lookup.)
const activeMeetings = new Map();
const PAUSE_AUTO_RESUME_MS = 10 * 60000; // a forgotten pause must not freeze social ticks forever

// Meeting phases — the structure every NON-social meeting runs through. Social
// chats collapse to a single `chat` phase (the PROPOSAL block below still fires).
// Decision/action synthesis is NOT a phase: one summary secretary owns it (see
// generateMeetingSummary) so there's one canonical action-item list, not N.
const OPENING_INSTRUCTION =
  "Open the meeting: give YOUR 1–2 sentence starting position on the topic — " +
  "your take, grounded in the context you were given. Do not yet react to others; " +
  "just stake your opening. Plain text, same language as the topic.";
const DISCUSSION_INSTRUCTION =
  "Build on the others: respond to what's been said, advance the topic, " +
  "stay concrete. Max 3 sentences, plain text, same language as the topic.";

// The social/break-room PROPOSAL instruction block — preserved verbatim. Keeping
// it as one extracted constant makes the social path explicit and prevents the
// regression where a phase rewrite silently drops project-pitch generation.
const SOCIAL_PROPOSAL_INSTRUCTION =
  `\n質は常に量より重要です。ほとんどのアイデアは「アイデアのまま」でよい — 本当に役立ち、実際に使え、` +
  `あなた自身が使う、またはオーナーが本当に使うものだけを提案してください。` +
  `使い捨てのおもちゃやゴミのような plugin を提案しないこと。また頻繁に提案しないこと — まだ固まっていない、または見合わないなら、まだ提案しないこと。\n` +
  `提案する前に、自分に問い切ること：誰が使う？本当に何の問題を解決する？なぜ作る価値がある？既存のものよりどこが優れている？\n` +
  `「本当に作るべき」プロジェクトとして固まったら、最後の行を追加してください：\n` +
  `PROPOSAL: <プロジェクト名> :: <明確に説明：何をするか、誰が使うか、何の問題を解決するか、なぜ見合うか — オーナーが判断できるように>\n` +
  `よく考え、大きく構想してよいです：本格的な plugin は UI があり、オーナーの問題を実際に解決します。または` +
  `実際に使えるウェブ/ウェブアプリ/プログラム/ツール（workspace 内の独立プロジェクト）でもよいです。その価値に見合った規模を選んでください。\n` +
  `安全のルールは一つだけ：BagIdea Office 本体を拡張するなら、必ず ` +
  `"plugin" として提案すること（docs/guide/plugins.md 参照 — plugin はプログラムに深くアクセスできます：panel, route, command, ` +
  `broadcast など。オーナーに本物の solution を届けられます）— コアシステム（daemon/godot/shell）を直接いじってはいけません。プログラムが壊れるからです。`;

// Meeting templates fill the launcher (topic + discussion depth). Pure data —
// the overlay maps them to a <select>; they never change phase structure.
const MEETING_TEMPLATES = [
  {
    id: "standup",
    label: "Standup",
    topic: "Standup: what you did / will do / blockers",
    rounds: 1,
  },
  {
    id: "retro",
    label: "Retro",
    topic: "Retro: what went well / badly / to improve",
    rounds: 2,
  },
  {
    id: "brainstorm",
    label: "Brainstorm",
    topic: "Brainstorm: generate ideas, no judgment yet",
    rounds: 3,
  },
  {
    id: "design-review",
    label: "Design Review",
    topic: "Design review: questions, critique, suggestions",
    rounds: 2,
  },
  {
    id: "planning",
    label: "Planning",
    topic: "Planning: goal, steps, owners, timeline",
    rounds: 2,
  },
];

// Build once-per-meeting grounding context. Projects come from the retrieval
// index (tier "proj"); per-agent private memory (workspace/memory/<id>.md) is
// returned keyed by agent so the caller injects it ONLY into that agent's own
// opening prompt — memory never crosses between agents.
function buildMeetingContext(topic, ids) {
  let projectBlurb = "";
  try {
    if (retrievalOk) {
      const hits = retrieval.search(topic, { k: 3, tiers: ["proj"] }) || [];
      if (hits.length)
        projectBlurb =
          "Related projects:\n" +
          hits
            .map(
              (h) =>
                `- ${(h.name || h.ref || "").slice(0, 80)}: ${(h.text || "").slice(0, 160)}`,
            )
            .join("\n");
    }
  } catch (e) {
    console.error("[meeting] context projects failed:", e && e.message);
  }
  const memory = {};
  try {
    for (const id of ids) {
      const file = path.join(WORKSPACE, "memory", `${id}.md`);
      const m = fs.existsSync(file) && fs.readFileSync(file, "utf8");
      if (m) memory[id] = m.slice(0, 1200); // private to this agent
    }
  } catch (e) {
    console.error("[meeting] context memory failed:", e && e.message);
  }
  return { projectBlurb, memory };
}

// Dynamic sliding window: enough turns to stay grounded, capped so a long
// meeting never feeds the whole transcript to every call. The cap (20) only
// bites around ~96 messages — a safety ceiling, not the common case.
function windowSize(len) {
  return Math.min(20, 8 + Math.floor(len / 8));
}

// Summarize a finished meeting in ONE call: markdown minutes + a fenced JSON
// actionItems[] array. Owners are validated against the roster (unknown owners
// are dropped — better a missing item than a phantom assignee). Returns
// { summary, actions } where either may be "" / [] if the model declines.
async function generateMeetingSummary(entry, ids) {
  const names = ids
    .map((id) => `${id} (${(reg.agents[id] || { name: id }).name})`)
    .join(", ");
  const transcript = entry.log
    .map(
      (m) =>
        `[${m.phase || "chat"}] ${(reg.agents[m.who] || { name: m.who }).name}: ${m.text}`,
    )
    .join("\n");
  const roster = ids.join(", ");
  const prompt =
    `You are the secretary summarizing a just-finished team meeting.\n` +
    `Topic: ${entry.title}\nParticipants: ${names}\n\nTranscript:\n${transcript}\n\n` +
    `Write a concise markdown summary with sections: ## Summary, ## Decisions, ## Open Questions.\n` +
    `Then output ONE fenced block of JSON — an array of action items, each ` +
    `{ "owner": "<one of: ${roster}>", "text": "<the follow-up>", "due": "<optional>" }.\n` +
    `Only use owners from the list above. If there are no action items, output [].\n` +
    `\`\`\`json\n[]\n\`\`\``;
  let raw = "";
  try {
    raw = await claudeText(prompt, { tools: "" });
  } catch (e) {
    console.error("[meeting] summary claudeText failed:", e && e.message);
  }
  // Pull the last fenced ```json ... ``` block out of the response.
  const blocks = [...raw.matchAll(/```json\s*([\s\S]*?)```/gi)].map(
    (m) => m[1],
  );
  let actions = [];
  if (blocks.length) {
    try {
      const parsed = JSON.parse(blocks[blocks.length - 1]);
      if (Array.isArray(parsed))
        actions = parsed
          .filter((a) => a && ids.includes(a.owner) && a.text)
          .map((a) => ({
            owner: a.owner,
            text: String(a.text).slice(0, 300),
            due: a.due || "",
          }));
    } catch (e) {
      console.error("[meeting] summary JSON parse failed:", e && e.message);
    }
  }
  // Summary prose = the markdown minus the fenced block(s).
  const summary = raw.replace(/```json\s*[\s\S]*?```/gi, "").trim();
  return { summary, actions };
}

async function runDiscussion(ids, topic, rounds, social, preKey) {
  activeDiscussions++;
  const task = "disc" + (Date.now() % 100000);
  // Every meeting is a persistent GROUP session ("@group" bucket): topic,
  // participants and the full transcript — readable later from the thread
  // menu, and written to workspace/meetings/ so agents can grep it too.
  const entry = {
    key: preKey || "g" + Date.now(),
    sid: null,
    ts: Date.now(),
    title: String(topic).replace(/\s+/g, " ").slice(0, 60),
    agents: ids.slice(),
    task,
    log: [],
  };
  sess["@group"] = sess["@group"] || [];
  sess["@group"].push(entry);
  saveSess();
  // Register as live so the owner can speak into it and control it. ctrl is a
  // shared object the loop re-reads every turn; /discuss/control mutates it.
  const ctrl = { paused: false, ended: false, pausedAt: 0 };
  activeMeetings.set(entry.key, { entry, ctrl });
  broadcast({
    type: "collab.started",
    agents: ids,
    task,
    text: topic,
    session: entry.key,
  });
  broadcast({
    type: "meeting.live",
    session: entry.key,
    topic: entry.title,
    agents: ids,
  });
  // Build grounding context once. projectBlurb is shared; memory[id] is private.
  const ctx = social
    ? { projectBlurb: "", memory: {} }
    : buildMeetingContext(topic, ids);
  // Phases: social collapses to one `chat` phase (PROPOSAL block still fires).
  const phases = social
    ? [{ name: "chat", instruction: "", rounds: rounds || 1 }]
    : [
        { name: "opening", instruction: OPENING_INSTRUCTION, rounds: 1 },
        {
          name: "discussion",
          instruction: DISCUSSION_INSTRUCTION,
          rounds: Math.max(1, rounds || 2),
        },
      ];
  try {
    outerPhase: for (const phase of phases) {
      for (let r = 0; r < phase.rounds; r++) {
        for (const id of ids) {
          // Re-fetch controls before each turn — End while paused must exit the
          // WHOLE meeting, not just the inner loop (hence the labeled break).
          if (ctrl.ended) break outerPhase;
          // Graceful pause: don't START the next turn (claudeText has no kill
          // path, so a mid-turn pause can't interrupt). Spin until resumed or
          // ended. Auto-resume after PAUSE_AUTO_RESUME_MS so a forgotten pause
          // can't freeze social ticks indefinitely.
          while (ctrl.paused && !ctrl.ended) {
            if (
              ctrl.pausedAt &&
              Date.now() - ctrl.pausedAt > PAUSE_AUTO_RESUME_MS
            ) {
              ctrl.paused = false;
              ctrl.pausedAt = 0;
              broadcast({
                type: "meeting.resumed",
                session: entry.key,
                via: "auto-resume",
              });
              break;
            }
            await new Promise((r) => setTimeout(r, 500));
          }
          if (ctrl.ended) break outerPhase;

          const a = reg.agents[id] || { name: id, role: "Staff", prompt: "" };
          // Sliding window — bounds each call instead of growing O(agents×rounds).
          const win = windowSize(entry.log.length);
          const recent = entry.log
            .slice(-win)
            .map(
              (m) =>
                `${(reg.agents[m.who] || { name: m.who }).name}: ${m.text}`,
            )
            .join("\n");
          const isOpening = phase.name === "opening";
          const text = await claudeText(
            `You are "${a.name}" (${a.role}) in a ${social ? "casual break-room chat" : "team meeting"} at the office.\n` +
              (a.prompt ? `Your persona: ${a.prompt}\n` : "") +
              `Meeting topic: ${topic}\n` +
              (ctx.projectBlurb && isOpening ? `${ctx.projectBlurb}\n` : "") +
              (isOpening && ctx.memory[id]
                ? `Your private memory (only you see this):\n${ctx.memory[id]}\n`
                : "") +
              (recent
                ? `Recent discussion:\n${recent}\n`
                : "You open the meeting.\n") +
              `Phase: ${phase.name}. ` +
              (social
                ? `Give YOUR next contribution as ${a.name}.`
                : phase.instruction) +
              `\n意見をより固めるために実際の情報が必要なら、自分で調べてよいです ` +
              `(WebSearch / WebFetch / Read) — 本当に必要なときだけにし、むやみに調べないこと。` +
              `そして通常どおり会話の文章で返してください。` +
              (social ? SOCIAL_PROPOSAL_INSTRUCTION : ""),
            {
              tools: social ? "" : "WebSearch,WebFetch,Read,Glob,Grep",
              provider: a && a.provider,
              model: a && a.model,
              env: { OFFICE_AGENT: id, OFFICE_TASK: task },
            },
          );
          let line = text.split("\n").filter(Boolean).join(" ").slice(0, 500);
          // If the owner pressed End while this claude call was in flight, drop the
          // lagging reply entirely — otherwise it would surface as a ghost message
          // AFTER meeting.ended has already fired and the summary has been written
          // (transcript would then disagree with the minutes).
          if (ctrl.ended) break outerPhase;
          // PROPOSAL: a project pitch for the owner to approve — protocol, not prose.
          const pm = text.match(/PROPOSAL:\s*([^:]+?)\s*::\s*(.+)/);
          if (pm) {
            line = line.replace(/PROPOSAL:.*$/, "").trim();
            addProposal(id, ids, pm[1], pm[2]);
          }
          if (line) {
            entry.log.push({
              who: id,
              text: line,
              ts: Date.now(),
              phase: phase.name,
            });
            saveSess();
            broadcast({
              type: "chat.message",
              agent: id,
              task,
              text: line,
              session: entry.key,
              phase: phase.name,
            });
          }
        }
      }
    }
  } finally {
    broadcast({ type: "collab.ended", agents: ids, task, session: entry.key });
    broadcast({ type: "meeting.ended", session: entry.key });
    activeMeetings.delete(entry.key);
    activeDiscussions = Math.max(0, activeDiscussions - 1);
    // One summary secretary → one canonical action-item list (per ADR-0001 these
    // live in their own .actions.json, NOT jobs.json, and NOT on Mission Control).
    // The summary call is best-effort: it must NEVER block or throw away the
    // minutes (a hung/slow/failed claude can't lose the transcript). Minutes are
    // written FIRST with whatever we have, then enriched if the summary lands.
    let summary = "",
      actions = [];
    try {
      ({ summary, actions } = social
        ? { summary: "", actions: [] }
        : await generateMeetingSummary(entry, ids));
    } catch (e) {
      console.error("[meeting] summary generation failed:", e && e.message);
      summary = "(summary generation failed)";
      actions = [];
    }
    // Always attempt to save and broadcast action items, even if summary failed
    try {
      if (actions.length) {
        const stamped = actions.map((a, i) => ({
          id: `${entry.key}-${i + 1}`,
          meeting: entry.key,
          owner: a.owner,
          text: a.text,
          due: a.due || "",
          status: "open",
          created: Date.now(),
        }));
        saveActions(entry.key, stamped);
        for (const a of stamped)
          broadcast({ type: "meeting.action", action: a, session: entry.key });
      }
    } catch (e) {
      console.error("[meeting] action items save failed:", e && e.message);
    }
    // Markdown minutes inside the agents' workspace — searchable by them.
    try {
      const dir = path.join(WORKSPACE, "meetings");
      fs.mkdirSync(dir, { recursive: true });
      const names = ids
        .map((id) => (reg.agents[id] || { name: id }).name)
        .join(", ");
      const summaryBlock = summary
        ? `## Summary\n\n${summary}\n\n## Transcript\n\n`
        : "";
      const md =
        `# Meeting: ${entry.title}\n\n- Date: ${new Date(entry.ts).toISOString()}\n` +
        `- Participants: ${names}\n\n${summaryBlock}` +
        entry.log
          .map(
            (m) =>
              `**[${m.phase || "chat"}] ${(reg.agents[m.who] || { name: m.who }).name}**: ${m.text}`,
          )
          .join("\n\n") +
        "\n";
      fs.writeFileSync(path.join(dir, `${entry.key}.md`), md);
      try {
        if (retrievalOk) {
          retrieval.addDoc(
            "arch",
            "meeting",
            `arch:meeting:${entry.key}`,
            md.slice(0, 1200),
          );
          retrieval.persist();
        }
      } catch {}
    } catch (e) {
      console.error("[meeting] minutes write failed:", e && e.message);
    }
  }
}

// ---------------------------------------------------------------- http

function readBody(req, cb) {
  // Collect raw bytes and decode once as UTF-8. Decoding per-chunk (body += c)
  // corrupts any multibyte char (e.g. 3-byte Thai) that straddles a chunk boundary.
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => cb(Buffer.concat(chunks).toString("utf8")));
}

function readBodyRaw(req, cb) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => cb(Buffer.concat(chunks)));
}

const MAPBG = path.join(__dirname, "map_bg.png");
let latestWorldPos = [];
const LAYOUT_FILE = path.join(__dirname, "layout.json"); // Office Editor
const PRESETS_FILE = path.join(__dirname, "presets.json"); // saved layouts
const ASSETS_FILE = path.join(__dirname, "assets.json"); // imported models/images

// Media file server for chat rendering (images / video / audio only).
const MEDIA_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
};
const isMediaPath = (p) =>
  !!MEDIA_MIME[String(p).split(".").pop().toLowerCase()];
function serveMedia(res, full, req) {
  const ext = full.split(".").pop().toLowerCase();
  const mime = MEDIA_MIME[ext];
  if (!mime) {
    res.writeHead(415);
    return res.end("not a media file");
  }
  fs.stat(full, (e, st) => {
    if (e || !st.isFile()) {
      res.writeHead(404);
      return res.end();
    }
    const total = st.size;
    const range = req && req.headers && req.headers.range;
    // Range support is REQUIRED for <video> to play/seek in Chromium/WebView2.
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (!(start >= 0)) start = 0;
      if (!(end < total)) end = total - 1;
      if (start > end) {
        res.writeHead(416, { "content-range": `bytes */${total}` });
        return res.end();
      }
      res.writeHead(206, {
        "content-type": mime,
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${total}`,
        "content-length": end - start + 1,
        "cache-control": "max-age=300",
      });
      fs.createReadStream(full, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "content-type": mime,
        "accept-ranges": "bytes",
        "content-length": total,
        "cache-control": "max-age=300",
      });
      fs.createReadStream(full).pipe(res);
    }
  });
}

const server = http.createServer((req, res) => {
  if (
    req.method === "GET" &&
    (req.url.split("?")[0] === "/" || req.url.split("?")[0] === "/index.html")
  ) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(fs.readFileSync(OVERLAY));
  } else if (req.method === "GET" && req.url.split("?")[0] === "/win") {
    // Custom-chrome frame for pop-out windows (dark title bar + the content in
    // an iframe) so plugin windows match the app instead of a bare OS frame.
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    try {
      res.end(fs.readFileSync(path.join(__dirname, "win.html")));
    } catch {
      res.end("<p>window frame unavailable</p>");
    }
  } else if (req.method === "GET" && req.url.split("?")[0] === "/winlang.js") {
    // Shared auto-translate helper for pop-out windows (Tools/Plugins Hub,
    // Workflow Builder): Thai source → office language via /i18n (cached + seeded).
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    });
    try {
      res.end(fs.readFileSync(path.join(__dirname, "winlang.js")));
    } catch {
      res.end(
        "window.WinLang={build:async()=>({lang:'th',map:{},tr:s=>s,ensure:async()=>{}})};",
      );
    }
  } else if (req.method === "GET" && req.url.split("?")[0] === "/watch") {
    // Read-only live activity stream for an agent (opened as its own window) —
    // it only listens on the WS, never sends, so it can't disturb the agent.
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    try {
      res.end(fs.readFileSync(path.join(__dirname, "watch.html")));
    } catch {
      res.end("<p>watch unavailable</p>");
    }
  } else if (req.method === "GET" && req.url.split("?")[0] === "/workflow") {
    // The human-language Workflow Builder canvas (opened as its own window).
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    try {
      res.end(fs.readFileSync(path.join(__dirname, "workflow.html")));
    } catch {
      res.end("<p>workflow builder unavailable</p>");
    }
  } else if (req.method === "GET" && req.url.split("?")[0] === "/toolshub") {
    // Tools Hub — a curated MCP-server catalog (browser, Google, DB…) to add new
    // agent capabilities in one click.
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    try {
      res.end(fs.readFileSync(path.join(__dirname, "toolshub.html")));
    } catch {
      res.end("<p>tools hub unavailable</p>");
    }
  } else if (req.method === "GET" && req.url.split("?")[0] === "/pluginshub") {
    // Plugins Hub — the community plugin catalog, browse + one-click install.
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    try {
      res.end(fs.readFileSync(path.join(__dirname, "pluginshub.html")));
    } catch {
      res.end("<p>plugins hub unavailable</p>");
    }
  } else if (
    req.method === "GET" &&
    req.url.split("?")[0] === "/plugins/catalog"
  ) {
    // The community plugin catalog — fetched LIVE from the website (so PR-curated
    // additions show up without waiting for an office update), falling back to the
    // copy bundled in the repo so it always works offline. Server-side fetch = no
    // CORS dance for the hub page.
    const sendLocal = () => {
      let txt = '{"plugins":[]}';
      try {
        txt = fs.readFileSync(
          path.join(__dirname, "..", "web", "plugins.json"),
          "utf8",
        );
      } catch {}
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(txt);
    };
    try {
      const https = require("https");
      const rq = https.get(
        "https://raw.githubusercontent.com/bagidea/bagidea-office/main/web/plugins.json",
        { timeout: 3500, headers: { "user-agent": "bagidea-office" } },
        (rs) => {
          if (rs.statusCode !== 200) {
            rs.resume();
            return sendLocal();
          }
          let d = "";
          rs.on("data", (c) => (d += c));
          rs.on("end", () => {
            try {
              JSON.parse(d);
              res.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
              });
              res.end(d);
            } catch {
              sendLocal();
            }
          });
        },
      );
      rq.on("error", sendLocal);
      rq.on("timeout", () => {
        rq.destroy();
        sendLocal();
      });
    } catch {
      sendLocal();
    }
  } else if (
    req.method === "GET" &&
    /^\/brand\/logo[a-z_]*\.png$/.test(req.url)
  ) {
    const f = path.join(
      __dirname,
      "..",
      "godot",
      "assets",
      "brand",
      req.url.split("/").pop(),
    );
    fs.readFile(f, (e, data) => {
      if (e) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "max-age=3600",
      });
      res.end(data);
    });
  } else if (req.method === "GET" && req.url.startsWith("/sfx/")) {
    // UI sounds from the (gitignored) sound pack — overlay falls back to a
    // tiny synth when a file is missing.
    const name = decodeURIComponent(req.url.slice(5)).replace(
      /[\\/]|\.\./g,
      "",
    );
    const f = path.join(__dirname, "..", "godot", "assets", "sounds", name);
    fs.readFile(f, (e, data) => {
      if (e) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "audio/wav",
        "cache-control": "max-age=86400",
      });
      res.end(data);
    });
  } else if (
    req.method === "GET" &&
    /^\/char\/npc([1-9]|1[0-2])\.png$/.test(req.url)
  ) {
    // Character sheets for overlay portraits (404 → CSS falls back to initials)
    const f = path.join(
      __dirname,
      "..",
      "godot",
      "assets",
      "characters",
      "npc",
      req.url.split("/").pop(),
    );
    fs.readFile(f, (e, data) => {
      if (e) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "max-age=3600",
      });
      res.end(data);
    });
  } else if (req.method === "POST" && req.url === "/chat") {
    readBody(req, async (body) => {
      try {
        let {
          agent = "main",
          prompt,
          session,
          wait,
          voice,
          files,
        } = JSON.parse(body);
        if (!prompt) throw new Error("no prompt");
        // Attached images → inline a text transcription so ANY brain can read them
        // (DeepSeek/GLM are text-only). The original paths still ride in the prompt for
        // multimodal brains to Read natively. Keep origPrompt for the chat LOG so the
        // (long) transcription only reaches the model, not the visible history.
        const origPrompt = prompt;
        try {
          const blk = await imageTextBlock(files);
          if (blk) prompt += blk;
        } catch {}
        // Saying a project's name binds the conversation to its directory.
        const project = projectFromPrompt(prompt);
        // wait:true (the CLI's ask) holds the response until the run truly
        // finishes and returns the final text.
        let waited = null;
        if (wait) {
          const safety = setTimeout(() => {
            if (waited) {
              waited = null;
              res.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
              });
              res.end(
                JSON.stringify({
                  ok: false,
                  text: "(タイムアウト 10分 — 業務はバックグラウンドで続行中)",
                }),
              );
            }
          }, 10 * 60000);
          waited = (text, ok) => {
            clearTimeout(safety);
            if (!waited) return;
            waited = null;
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
            });
            res.end(JSON.stringify({ ok, text: String(text || "") }));
          };
        }
        // CEO orders route through the Director; talking to the Director
        // directly gives him the same dispatch power. New threads adopt the
        // requested project workspace.
        const task =
          agent === "ceo"
            ? ceoFlow(prompt, session, project, {
                logPrompt: voice
                  ? "🎤👑 (音声で指示) " + origPrompt
                  : origPrompt,
                relay: true, // mirror the CEO conversation to connected channels
                onDone: wait ? (t, ok) => waited && waited(t, ok) : undefined,
              })
            : agent === "main"
              ? runClaude("main", prompt + directorNote(), {
                  session,
                  project,
                  logPrompt: origPrompt,
                  filterText: makeDelegateFilter(0, session),
                  onDone: wait ? (t, ok) => waited && waited(t, ok) : undefined,
                })
              : runClaude(agent, prompt, {
                  session,
                  project,
                  logPrompt: origPrompt,
                  resumable: true,
                  resumePrompt: origPrompt, // a member's direct task auto-resumes
                  onDone: wait ? (t, ok) => waited && waited(t, ok) : undefined,
                });
        if (!wait) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ task }));
        }
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url.startsWith("/sessions/log")) {
    // Per-thread chat history for the overlay.
    const q = new URL(req.url, "http://x").searchParams;
    const entry = (sess[q.get("agent")] || []).find(
      (e) => e.key === q.get("key"),
    );
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    // live=true tells the overlay it may show the speak bar + controls for this
    // meeting (a finished Meeting Log stays read-only). Only group meetings are
    // ever live; @sub logs never are.
    res.end(
      JSON.stringify({
        log: (entry && entry.log) || [],
        live: !!(entry && activeMeetings.has(entry.key)),
      }),
    );
  } else if (req.method === "GET" && req.url === "/sessions/all") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ all: sess }));
  } else if (req.method === "POST" && req.url === "/sessions/delete") {
    readBody(req, (body) => {
      try {
        const { agent, key } = JSON.parse(body);
        sess[agent] = (sess[agent] || []).filter((s) => s.key !== key);
        if (!sess[agent].length) delete sess[agent];
        saveSess();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (
    req.method === "GET" &&
    req.url.startsWith("/sessions/") &&
    req.url.includes("/actions")
  ) {
    // GET /sessions/:key/actions — retrieve action items for a historical meeting
    const pathParts = req.url.split("/");
    const key = pathParts[2];
    try {
      const actions = loadActions(key);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ actions }));
    } catch (e) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ actions: [] }));
    }
  } else if (req.method === "GET" && req.url === "/meeting-templates") {
    // GET /meeting-templates — serve meeting templates to eliminate client-side duplication
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ templates: MEETING_TEMPLATES }));
  } else if (req.method === "GET" && req.url.startsWith("/sessions")) {
    const agent =
      new URL(req.url, "http://x").searchParams.get("agent") || "main";
    const list = (sess[agent] || [])
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 20);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions: list }));
  } else if (req.method === "GET" && req.url === "/brains") {
    // Monitoring snapshot: every provider's connect status + every agent's brain
    // (provider/model) and latest context usage. Feeds the 🧠 BRAINS sidebar panel.
    const pc = reg.providerConfig || {};
    const KNOWN = [
      "claude",
      "glm",
      "deepseek",
      "qwen",
      "minimax",
      "moonshot",
      "openai",
      "gemini",
      "openrouter",
      "nvidia",
      "groq",
      "cerebras",
      "xai",
      "mistral",
      "together",
      "fireworks",
      "ollama",
      "lmstudio",
    ];
    const byProvider = {};
    const agents = [];
    for (const [id, a] of Object.entries(reg.agents || {})) {
      if (id === "ceo") continue;
      const p = a.provider || reg.defaultProvider || "claude";
      const list = sess[id] || [];
      const latest = list.length
        ? list.reduce((x, y) => (x.ts > y.ts ? x : y))
        : null;
      const lu = latest && latest.lastUsage;
      const usage = lu
        ? {
            in: lu.in,
            out: lu.out,
            win: lu.win,
            pct: lu.win ? Math.min(100, Math.round((lu.in / lu.win) * 100)) : 0,
            ts: lu.ts,
          }
        : null;
      agents.push({
        id,
        name: a.name,
        role: a.role,
        provider: p,
        model: a.model || "",
        tag: modelTag(id),
        usage,
      });
      (byProvider[p] = byProvider[p] || []).push(id);
    }
    const ids = Array.from(new Set([...KNOWN, ...Object.keys(pc)]));
    const providers = ids
      .map((id) => {
        const c = pc[id] || {};
        return {
          id,
          label: c.label || id,
          kind: c.kind || (KNOWN.includes(id) ? "" : "custom"),
          connected: id === "claude" ? true : !!c.connected,
          agents: byProvider[id] || [],
        };
      })
      .filter((p) => p.connected || p.agents.length || pc[p.id]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        providers,
        agents,
        defaultProvider: reg.defaultProvider || "claude",
      }),
    );
  } else if (req.method === "POST" && req.url === "/discuss") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        const ids = (p.agents || []).filter((id) => id !== "ceo").slice(0, 4);
        // Validate every participant exists in the roster — a stray id would
        // otherwise be silently impersonated by the {name:id} fallback.
        const bad = ids.find((id) => !reg.agents[id]);
        if (bad) throw new Error("unknown agent: " + bad);
        if (ids.length < 2) throw new Error("need at least 2 agents");
        if (!p.topic) throw new Error("no topic");
        // Concurrent meetings are allowed — disjoint teams huddle in parallel,
        // and the wallpaper ghost-splits anyone double-booked.
        const mkey = "g" + Date.now();
        runDiscussion(
          ids,
          String(p.topic),
          Math.min(Math.max(Number(p.rounds) || 2, 1), 3),
          false,
          mkey,
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, session: mkey }));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/discuss/message") {
    // Owner speaks into a LIVE meeting. No async chain, no per-agent claudeText:
    // we just append the CEO's line to entry.log (phase "user") and broadcast
    // it. The main loop's sliding window picks it up on the next agent's turn,
    // so replies arrive in turn order — no racing claude processes.
    // Owner-only — this is the human speaking AS the CEO into the meeting, so an
    // agent must not be able to forge a CEO line and steer the discussion.
    if (!req.headers["x-bagidea-ui"]) {
      res.writeHead(403);
      return res.end("human UI only");
    }
    readBody(req, (body) => {
      try {
        const { session, text } = JSON.parse(body);
        const live = activeMeetings.get(session);
        if (!live) {
          res.writeHead(404);
          return res.end("meeting not live");
        }
        const msg = String(text || "")
          .trim()
          .slice(0, 1000);
        if (!msg) throw new Error("empty message");
        live.entry.log.push({
          who: "ceo",
          text: msg,
          ts: Date.now(),
          phase: "user",
        });
        saveSess();
        broadcast({
          type: "chat.message",
          agent: "ceo",
          task: live.entry.task,
          text: msg,
          session,
          phase: "user",
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/discuss/control") {
    // Pause / resume / skip / end a live meeting. Mutates the shared ctrl object
    // the loop re-reads every turn — graceful (pause = don't start next turn).
    // Owner-only — the human controls meetings, not an agent (which could otherwise
    // silently end or stall a discussion). Same boundary as the other control routes.
    if (!req.headers["x-bagidea-ui"]) {
      res.writeHead(403);
      return res.end("human UI only");
    }
    readBody(req, (body) => {
      try {
        const { session, action } = JSON.parse(body);
        const live = activeMeetings.get(session);
        if (!live) {
          res.writeHead(404);
          return res.end("meeting not live");
        }
        const c = live.ctrl;
        switch (String(action)) {
          case "pause":
            c.paused = true;
            c.pausedAt = Date.now();
            break;
          case "resume":
            c.paused = false;
            c.pausedAt = 0;
            break;
          case "skip":
            /* loop advances naturally; no-op flag */ break;
          case "end":
            c.ended = true;
            c.paused = false;
            break;
          default:
            throw new Error("bad action");
        }
        broadcast({
          type: "meeting.control",
          session,
          action,
          paused: c.paused,
          ended: c.ended,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, paused: c.paused, ended: c.ended }));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/map/bg") {
    // Godot ships a one-shot orthographic floorplan render at boot.
    readBodyRaw(req, (buf) => {
      fs.writeFile(MAPBG, buf, () => {});
      broadcast({ type: "ui.mapbg" }, false); // overlays refresh the image
      res.writeHead(200);
      res.end("ok");
    });
  } else if (req.method === "GET" && req.url.startsWith("/map/bg")) {
    fs.readFile(MAPBG, (e, data) => {
      if (e) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store",
      });
      res.end(data);
    });
  } else if (req.method === "POST" && req.url === "/pos") {
    // 1 Hz live positions from the renderer → overlay map (never journaled).
    readBody(req, (body) => {
      try {
        latestWorldPos = (JSON.parse(body).agents || []).slice(0, 300);
        broadcast({ type: "world.pos", agents: latestWorldPos }, false);
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
  } else if (req.method === "GET" && req.url === "/pos/latest") {
    // Last world positions for shell-side hit layers (never journaled). The shell's
    // hit layer is loaded via with_html (origin "null"), so this cross-origin fetch
    // needs an explicit CORS header or the WebView blocks the JS from reading it.
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify({ agents: latestWorldPos }));
  } else if (req.method === "GET" && req.url.startsWith("/focus")) {
    // Wallpaper click on a character -> tell the renderer to stop that agent and
    // zoom the camera in on them. GET (a "simple" cross-origin request) so the
    // hit layer's fetch needs no CORS preflight; never journaled.
    let fid = "";
    try {
      fid = new URL(req.url, "http://x").searchParams.get("id") || "";
    } catch {}
    fid = String(fid).slice(0, 120);
    // An empty id is the "clear" signal (chat closed -> zoom back out), so
    // always broadcast -- the renderer decides focus vs release.
    broadcast({ type: "world.focus", agent: fid }, false);
    res.writeHead(200, {
      "content-type": "text/plain",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end("ok");
  } else if (req.method === "GET" && req.url === "/registry") {
    // Ship the backend's curated model catalog alongside reg so the brain picker
    // has ONE source of truth. The frontend used to carry its own hardcoded
    // MODELS/BEST_MODEL copy that drifted stale (e.g. it still showed glm-4.6 long
    // after glm-5.2 shipped) — that duplicate was the real "models don't update"
    // bug. best = newest = the first non-empty curated id (catalogs list newest
    // first; claude keeps its explicit default). hasModelsUrl tells the UI a LIVE
    // list can be pulled (any openai-format provider, or an anthropic one that
    // declares modelsUrl).
    const providerCatalog = {};
    for (const [id, spec] of Object.entries(providers.PROVIDERS)) {
      const models = (spec.models || []).slice();
      providerCatalog[id] = {
        models,
        best:
          id === "claude" ? "claude-opus-4-8" : models.filter(Boolean)[0] || "",
        hasModelsUrl: !!spec.modelsUrl || spec.format === "openai",
      };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...reg, providerCatalog }));
  } else if (req.method === "GET" && req.url.startsWith("/recall")) {
    // Relevance search over the office's memory / projects / owner facts /
    // skills / meeting archive. Read-only; the archive-search skill curls this.
    const u = new URL(req.url, "http://x");
    const q = u.searchParams.get("q") || "";
    const k = Math.min(
      20,
      Math.max(1, parseInt(u.searchParams.get("k") || "8", 10) || 8),
    );
    const tiers = (u.searchParams.get("tiers") || "")
      .split(",")
      .filter(Boolean);
    let hits = [];
    try {
      if (retrievalOk)
        hits = retrieval.search(q, {
          k,
          tiers: tiers.length ? tiers : undefined,
        });
    } catch {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        q,
        hits,
        stats: retrievalOk ? retrieval.stats() : null,
      }),
    );
  } else if (req.method === "POST" && req.url === "/registry/agent") {
    // Create or update an agent — including its BRAIN (provider/model), persona,
    // skills and tools. Owner-only (the human editor): a teammate must never be able
    // to reassign its own or anyone else's model. An agent told to "use the right
    // model for the job" routes the work to whoever already has that brain — it does
    // not edit brains here. Without the UI header this is a 403.
    if (!req.headers["x-bagidea-ui"]) {
      res.writeHead(403);
      return res.end(
        "human UI only — agents route work, they don't change brains",
      );
    }
    // Protected rows (main/ceo) accept edits but never deletion; id is derived
    // from the name on first save.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        const id = p.id || slugId(p.name);
        // Hire cap (MAX_STAFF, module constant) — CEO not counted.
        if (!reg.agents[id]) {
          if (staffCount() >= MAX_STAFF) {
            res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
            return res.end(
              `オフィスが満員です — 従業員は最大 ${MAX_STAFF} 名まで（CEO を除く）。` +
                `並行作業にはゴースト分身（sub-agents）を使ってください`,
            );
          }
        }
        const cur = reg.agents[id] || { skills: [], tools: [] };
        const px = p.persona || cur.persona || {};
        reg.agents[id] = {
          ...cur,
          name: String(p.name || cur.name || id).slice(0, 40),
          role: String(p.role || cur.role || "Specialist").slice(0, 40),
          avatar: Math.min(
            Math.max(Number(p.avatar) || cur.avatar || 1, 1),
            12,
          ),
          aura: String(p.aura !== undefined ? p.aura : cur.aura || "").slice(
            0,
            16,
          ),
          prompt: String(
            p.prompt !== undefined ? p.prompt : cur.prompt || "",
          ).slice(0, 8000),
          persona: {
            expertise: String(px.expertise || "").slice(0, 2000),
            personality: String(px.personality || "").slice(0, 2000),
            language: String(px.language || "").slice(0, 80),
            rules: String(px.rules || "").slice(0, 2000),
          },
          tier: Math.min(
            Math.max(Number(p.tier !== undefined ? p.tier : cur.tier) || 3, 1),
            3,
          ),
          voice: String(
            p.voice !== undefined ? p.voice : cur.voice || "",
          ).slice(0, 20),
          skills: Array.isArray(p.skills) ? p.skills : cur.skills || [],
          tools: Array.isArray(p.tools) ? p.tools : cur.tools || [],
          // 🧠 swappable brain: which backend/model this agent runs on (default Claude).
          // Accept both built-in PROVIDERS and custom ones from providerConfig.
          provider:
            providers.PROVIDERS[p.provider] ||
            (reg.providerConfig && reg.providerConfig[p.provider])
              ? p.provider
              : cur.provider || "claude",
          model: String(
            p.model !== undefined ? p.model : cur.model || "",
          ).slice(0, 60),
        };
        saveReg();
        pushRoster();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id }));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/registry/agent/delete") {
    // Owner-only — a teammate must not be able to remove other teammates.
    if (!req.headers["x-bagidea-ui"]) {
      res.writeHead(403);
      return res.end("human UI only");
    }
    readBody(req, (body) => {
      try {
        const { id } = JSON.parse(body);
        const a = reg.agents[id];
        if (!a) {
          res.writeHead(404);
          return res.end("unknown agent");
        }
        if (a.protected) {
          res.writeHead(403);
          return res.end("protected agent");
        }
        delete reg.agents[id];
        saveReg();
        broadcast({ type: "roster.removed", agent: id }, false);
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/registry/skill") {
    // Create, update or remove a skill in the library. Removal also strips
    // the skill from every agent that had it assigned.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        // Built-in skills are ours — the baseline every office needs (plugin building,
        // office control, etc.). They can be ASSIGNED to agents but never edited or
        // deleted; only user/agent-created skills are mutable.
        const tgt = p.id && reg.skills[p.id];
        if (tgt && tgt.builtin) {
          res.writeHead(409);
          return res.end("built-in skill — cannot edit or remove");
        }
        if (p.remove) {
          delete reg.skills[p.id];
          for (const a of Object.values(reg.agents))
            a.skills = (a.skills || []).filter((s) => s !== p.id);
        } else {
          const id = p.id || slugId(p.name);
          // A new skill must not collide with / overwrite a built-in id either.
          if (!p.id && reg.skills[id] && reg.skills[id].builtin) {
            res.writeHead(409);
            return res.end("name collides with a built-in skill");
          }
          reg.skills[id] = {
            ...(reg.skills[id] || {}),
            name: String(p.name || id).slice(0, 60),
            description: String(p.description || "").slice(0, 200),
            content: String(p.content || "").slice(0, 4000),
          };
        }
        saveReg();
        // Keep the retrieval index's skill tier in step with the edit.
        try {
          if (retrievalOk) {
            if (p.remove) retrieval.removeDoc("skill:" + p.id);
            else {
              const sid = p.id || slugId(p.name);
              retrieval.reindexSkill(sid, reg.skills[sid]);
            }
            retrieval.persist();
          }
        } catch {}
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/registry/mcp") {
    // Custom capability = MCP servers (the Claude Code plugin standard).
    // name + launch command; assignment per agent via "mcp:<name>" entries.
    readBody(req, (body) => {
      try {
        const { name, command, remove } = JSON.parse(body);
        const n = String(name || "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, "-")
          .slice(0, 40);
        if (!n) throw new Error("no name");
        if (remove) {
          delete reg.mcpServers[n];
          for (const a of Object.values(reg.agents))
            a.tools = (a.tools || []).filter((t) => t !== "mcp:" + n);
        } else {
          if (!command) throw new Error("no command");
          reg.mcpServers[n] = { command: String(command).trim().slice(0, 300) };
        }
        saveReg();
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url === "/projects") {
    sweepProjects(); // freshen window truth in the background for next read
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ projects: projectStatus(), places: reg.places }));
  } else if (req.method === "POST" && req.url === "/projects") {
    // Register/create a project: name + (place shorthand | full path).
    // `remove` unregisters from the list only (files untouched);
    // `removeDisk` REALLY deletes the folder — allowed only for projects
    // this app created itself.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        // Removal is HUMAN-ONLY: the overlay sends this header; an agent's
        // curl can never unregister or delete a project again.
        const humanUI = !!req.headers["x-bagidea-ui"];
        if (p.remove) {
          if (!humanUI) {
            res.writeHead(403);
            return res.end("human UI only");
          }
          // Closing/removing a project must also close its real OS window —
          // otherwise the terminal lingers, orphaned from a project that's gone.
          winproj("stop", String(p.remove).replace(/[^\w-]/g, ""), () => {});
          projects = projects.filter((x) => x.id !== p.remove);
          saveProjects();
          broadcast({ type: "projects.changed" }, false);
          res.writeHead(200);
          return res.end("ok");
        }
        if (p.removeDisk) {
          if (!humanUI) {
            res.writeHead(403);
            return res.end("human UI only");
          }
          const proj = projects.find((x) => x.id === p.removeDisk);
          if (!proj) {
            res.writeHead(404);
            return res.end("unknown project");
          }
          if (!proj.created) {
            res.writeHead(403);
            return res.end("not created by this app");
          }
          // Folders die hard: a dev server an agent left running
          // (next dev, vite, …) or the project's own terminal keeps files
          // locked and rmSync silently half-deletes. Order of battle:
          // close our project window → kill processes anchored in the dir →
          // delete with retries → readable error if something still holds on.
          const pid = p.removeDisk;
          const killProjectProcesses = (dir, cb) => {
            if (process.platform === "win32") {
              winproj("killdir", dir, cb);
            } else {
              // macOS/Linux: kill processes whose cwd or args reference this dir.
              // Use execFileSync (NOT execSync) to prevent shell injection via
              // project paths containing special characters.
              const { execFileSync } = require("child_process");
              try {
                const out = execFileSync("lsof", ["+D", dir], {
                  timeout: 5000,
                  stdio: ["pipe", "pipe", "pipe"],
                }).toString();
                const pids = new Set();
                for (const line of out.split("\n").slice(1)) {
                  const cols = line.trim().split(/\s+/);
                  if (cols[1]) pids.add(cols[1]);
                }
                pids.forEach((p) => {
                  try {
                    process.kill(parseInt(p), "SIGTERM");
                  } catch {}
                });
              } catch {}
              setTimeout(cb, 500);
            }
          };
          winproj("stop", pid, () =>
            killProjectProcesses(proj.dir, () => {
              setTimeout(() => {
                try {
                  fs.rmSync(proj.dir, {
                    recursive: true,
                    force: true,
                    maxRetries: 6,
                    retryDelay: 350,
                  });
                } catch (e) {
                  res.writeHead(409, {
                    "content-type": "text/plain; charset=utf-8",
                  });
                  return res.end(
                    `削除に失敗しました — フォルダ内のファイルが使用中です（${e.code || e.message}）。` +
                      `このフォルダで開いたままのプログラム/ターミナルを閉じてから、もう一度 🗑 を押してください`,
                  );
                }
                projects = projects.filter((x) => x.id !== pid);
                saveProjects();
                broadcast({ type: "projects.changed" }, false);
                res.writeHead(200);
                res.end("ok");
              }, 700);
            }),
          );
          return;
        }
        const proj = createProject(p.name, p.place, p.path);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(proj));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/projects/open") {
    // ▶ open = the smart claude entry (no sessions → claude, one → -c,
    // several → -r so the user picks). 🖥 shell = plain terminal, NOT
    // counted as "project open" (no liveness marker).
    readBody(req, (body) => {
      try {
        const { id, mode = "play" } = JSON.parse(body);
        const dir = projectDir(id);
        if (!dir) {
          res.writeHead(404);
          return res.end("unknown project");
        }
        const launch = (psCmd, title) => {
          if (process.platform === "win32") {
            // Windows Terminal when present (beautiful Thai fonts; a NEW
            // window, default-profile fonts), classic conhost as fallback.
            // --suppressApplicationTitle LOCKS the title: it's how hide/resume
            // finds exactly OUR window — WT shares one process across every
            // window, so titles are the only safe handle.
            const line = HAS_WT
              ? `/c start "" "${WT_EXE}" -w new new-tab --title "${title}" --suppressApplicationTitle -d "${dir}" powershell -NoLogo -NoExit -ExecutionPolicy Bypass ${psCmd}`
              : `/c start "${title}" /D "${dir}" conhost.exe powershell -NoLogo -NoExit -ExecutionPolicy Bypass ${psCmd}`;
            spawn("cmd.exe", [line], {
              windowsVerbatimArguments: true,
              windowsHide: true,
              detached: true,
            });
          } else if (process.platform === "darwin") {
            // macOS: Open a new Terminal.app window, cd to project dir, run
            // claude, then set the window's custom title to BAGIDEA_PROJ_<id>
            // so macproj.sh sweep can identify it — mirrors the Windows
            // --suppressApplicationTitle approach.
            const cmd = psCmd || "";
            // psCmd on Windows is `-Command "..."` — extract the inner command for macOS
            const innerCmd = cmd.match(/-Command\s+"(.+)"/)?.[1] || "";
            const shellCmd = innerCmd || "exec bash";
            // Extract marker (#BAGIDEA_PROJ_<id>) from the command, or fall
            // back to the title parameter the caller already passes.
            const marker =
              (innerCmd.match(/#(BAGIDEA_PROJ_[\w-]+)/) || [])[1] || title;
            const esc = (s) => s.replace(/'/g, "'\\''");
            // Escape for AppleScript double-quoted string: backslash first, then dquote.
            const asEsc = (s) =>
              String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            // Capture the tab reference from `do script` so `set custom title`
            // targets exactly the window we just opened — `front window` is a
            // race when Terminal is busy creating the tab.
            const script = `tell application "Terminal"
  set t to do script "cd '${esc(dir)}' && ${esc(shellCmd)}"
  set custom title of (window 1 where tabs contains t) to "${asEsc(marker)}"
end tell`;
            spawn("osascript", ["-e", script], { detached: true });
          } else {
            // Linux: open a terminal at `dir` running the command. The Windows psCmd is
            // `-Command "<cmd> #marker"`; extract <cmd> (the #marker is also a bash
            // comment, so it's harmless). We don't track the window — winproj() is a
            // no-op on Linux, so hide/resume just don't apply.
            const m = String(psCmd).match(/^-Command "([\s\S]*)"$/);
            const inner = m ? m[1] : "";
            const openLinuxTerm = () => {
              const bashLine = `cd ${JSON.stringify(dir)}; ${inner ? inner + "; " : ""}exec bash`;
              const terms = [
                ["x-terminal-emulator", ["-e", "bash", "-lc", bashLine]],
                [
                  "gnome-terminal",
                  ["--working-directory=" + dir, "--", "bash", "-lc", bashLine],
                ],
                ["konsole", ["--workdir", dir, "-e", "bash", "-lc", bashLine]],
                [
                  "xfce4-terminal",
                  [
                    "--working-directory=" + dir,
                    "-e",
                    "bash -lc " + JSON.stringify(bashLine),
                  ],
                ],
                ["xterm", ["-e", "bash", "-lc", bashLine]],
              ];
              (function tryTerm(i) {
                if (i >= terms.length) return;
                const c = spawn(terms[i][0], terms[i][1], {
                  detached: true,
                  stdio: "ignore",
                });
                c.on("error", () => tryTerm(i + 1));
              })(0);
            };
            if (wslx.isWSL()) {
              // Hybrid: open a REAL Windows Terminal window (interop) that drops
              // back into this WSL dir — claude still runs on the WSL side.
              // Same --suppressApplicationTitle marker as win32, so the winproj
              // hide/resume sweep finds the window. wt.exe missing → fall
              // back to a WSLg terminal.
              // wt.exe treats `;` as its OWN tab delimiter — even inside a
              // quoted commandline — so an unescaped "claude …; exec bash"
              // spawns a phantom second tab running `exec bash` (0x80070002,
              // file-not-found). Escape it as `\;` so WT passes a literal `;`
              // through to bash (documented WT escape). The marker rides in as
              // a bash comment (#BAGIDEA_PROJ_x) so the winproj sweep still
              // sees it in `ps`.
              spawn(
                "wt.exe",
                [
                  "-w",
                  "new",
                  "new-tab",
                  "--title",
                  title,
                  "--suppressApplicationTitle",
                  "wsl.exe",
                  "--cd",
                  dir,
                  "--",
                  "bash",
                  "-lic",
                  `${inner ? inner + "\\; " : ""}exec bash`,
                ],
                { detached: true, stdio: "ignore", cwd: wslx.INTEROP_CWD },
              ).on("error", openLinuxTerm);
            } else {
              openLinuxTerm();
            }
          }
        };
        if (mode === "folder") {
          if (wslx.isWSL()) {
            // Hybrid: show the WSL dir in the WINDOWS Explorer (\\wsl.localhost).
            const w = wslx.toWinPath(dir);
            spawn("explorer.exe", [w || dir], {
              detached: true,
              cwd: wslx.INTEROP_CWD,
            }).on("error", (e) =>
              console.error("[hybrid] explorer.exe:", e.message),
            );
          } else {
            const openCmd = process.platform === "win32" ? "explorer" : "open";
            spawn(openCmd, [dir], { detached: true });
          }
        } else if (mode === "shell") {
          // Plain shell, no marker — not counted as "project open".
          launch("", path.basename(dir));
        } else if (id in projWin) {
          // ONE window per project, always: if it exists (even hidden),
          // surface THAT — never spawn a second one on top of it.
          winproj("show", id, () => sweepProjects());
        } else {
          // LOCK (one occupant at a time): while an agent is working inside this
          // project you can't open it — opening would fork its live session. Stop
          // the agent (⏹) to take over, or wait for it to finish. The reverse
          // also holds: an agent won't be dispatched into a project you have open.
          if ((projRuns[id] || 0) > 0) {
            res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
            return res.end(
              "agent がこのプロジェクトで作業中です — 中を見る/自分でやるには先に ⏹ を押して止めるか、業務が終わるまで待ってください",
            );
          }
          ensureTrusted(dir); // no trust dialog ambush in the new window
          // Smart entry: resume the NEWEST session explicitly — straight into
          // where the work happened. Fresh claude only when there's no session.
          const sid = newestSid(dir);
          const cmd = sid ? `claude --resume ${sid}` : "claude";
          launch(`-Command "${cmd} #BAGIDEA_PROJ_${id}"`, `BAGIDEA_PROJ_${id}`);
          setTimeout(sweepProjects, 2500);
        }
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (
    req.method === "POST" &&
    (req.url === "/projects/stop" ||
      req.url === "/projects/hide" ||
      req.url === "/projects/resume")
  ) {
    // ⏹ stop kills the window tree for real. 🫥 hide tucks the window away
    // while claude keeps working; ▶ resume brings the same window back.
    readBody(req, (body) => {
      try {
        const { id } = JSON.parse(body);
        const action = req.url.endsWith("stop")
          ? "stop"
          : req.url.endsWith("hide")
            ? "hide"
            : "show";
        winproj(action, String(id).replace(/[^\w-]/g, ""), () => {
          sweepProjects();
          // After a stop, confirm again once the window/process has fully gone —
          // an immediate sweep can still race the kill and re-flag it as open.
          if (action === "stop") setTimeout(sweepProjects, 1500);
        });
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/task/stop") {
    // ⏹ Cancel a running agent task mid-flight (kill its claude child by task id).
    if (!req.headers["x-bagidea-ui"]) {
      res.writeHead(403);
      return res.end("human UI only");
    }
    readBody(req, (body) => {
      try {
        const { task, agent } = JSON.parse(body);
        const kill = (rec, t) => {
          if (rec) {
            killTree(rec.child);
          }
          runChildren.delete(t);
          // Always clear the strip — covers stale/replayed entries whose child is already gone.
          broadcast({
            type: "task.completed",
            agent: (rec && rec.agent) || agent || "",
            task: t,
          });
        };
        if (task) kill(runChildren.get(task), task);
        if (agent) {
          for (const [t, rec] of [...runChildren])
            if (rec.agent === agent) kill(rec, t);
        }
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/projects/stopwork") {
    // ⏹ Stop the AGENT working inside a project so the owner can take it over
    // (the lock's "stop to enter" path). Human-UI only.
    if (!req.headers["x-bagidea-ui"]) {
      res.writeHead(403);
      return res.end("human UI only");
    }
    readBody(req, (body) => {
      try {
        const { id } = JSON.parse(body);
        const set = projChildren[id];
        if (set) {
          for (const c of set) {
            killTree(c);
          }
        }
        // Clear the lock immediately; the children's close handlers also settle it.
        projChildren[id] = new Set();
        projRuns[id] = 0;
        projAgents[id] = {};
        broadcast({ type: "projects.changed" }, false);
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url.startsWith("/fs")) {
    // Directory listing for the in-house folder picker (Blender-style UI in
    // the overlay — no off-theme Windows dialogs).
    {
      const q = new URL(req.url, "http://x").searchParams;
      let dir = q.get("dir") || "";
      const drives = [];
      if (process.platform === "win32") {
        for (let c = 65; c <= 90; c++) {
          const d = String.fromCharCode(c) + ":\\";
          try {
            if (fs.existsSync(d)) drives.push(d);
          } catch {}
        }
      }
      if (!dir) {
        if (process.platform === "win32") {
          dir = drives.includes("D:\\") ? "D:\\" : drives[0] || "C:\\";
        } else {
          dir = require("os").homedir();
        }
      }
      let dirs = [];
      try {
        dirs = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter(
            (e) =>
              e.isDirectory() &&
              !e.name.startsWith(".") &&
              !e.name.startsWith("$"),
          )
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
      } catch {}
      const parent = path.dirname(dir);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          path: dir,
          parent: parent === dir ? null : parent,
          dirs,
          drives,
        }),
      );
    }
  } else if (req.method === "POST" && req.url === "/fs/mkdir") {
    readBody(req, (body) => {
      try {
        const { dir, name } = JSON.parse(body);
        const n = String(name || "")
          .trim()
          .replace(/[<>:"/\\|?*]/g, "");
        if (!dir || !n) throw new Error("need dir + name");
        fs.mkdirSync(path.join(dir, n));
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/fs/native-pick") {
    // Native OS folder picker — cross-platform:
    //   macOS:   osascript `choose folder` (NSOpenPanel)
    //   Windows: PowerShell FolderBrowserDialog
    //   Linux:   zenity --file-selection --directory (if installed)
    // Linux without zenity returns 404 so the client falls back to the
    // in-house picker. A cancelled dialog returns { path: null }.
    // Human-UI only, same boundary as the other /fs + /task + /projects
    // endpoints that surface a modal dialog to the user.
    if (!req.headers["x-bagidea-ui"]) {
      res.writeHead(403);
      return res.end("human UI only");
    }
    const { execFile } = require("child_process");
    const picked = (p) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ path: p || null }));
    };
    if (process.platform === "darwin") {
      execFile(
        "osascript",
        ["-e", 'try\nPOSIX path of (choose folder)\non error\n""\nend try'],
        { timeout: 300000 },
        (e, out) => {
          if (e) {
            res.writeHead(500);
            res.end(String(e.message));
            return;
          }
          picked(String(out || "").trim());
        },
      );
    } else if (process.platform === "win32") {
      // FolderBrowserDialog.ShowDialog() needs STA. powershell.exe (5.1, the
      // common case) is STA by default so this just works. pwsh (7+) is MTA
      // and would throw — we hardcode "powershell" (5.1) to stay on STA.
      const ps =
        "Add-Type -AssemblyName System.Windows.Forms; " +
        "$f = New-Object System.Windows.Forms.FolderBrowserDialog; " +
        "if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath } else { '' }";
      execFile(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
        { timeout: 300000, windowsHide: true },
        (e, out) => {
          if (e) {
            res.writeHead(500);
            res.end(String(e.message));
            return;
          }
          picked(String(out || "").trim());
        },
      );
    } else if (wslx.isWSL()) {
      // Hybrid: pop the WINDOWS folder picker via interop (powershell 5.1 =
      // STA, same constraint as the win32 branch), then map the choice back
      // to a WSL path (C:\… → /mnt/c/…, \\wsl.localhost\… → native).
      const ps =
        "Add-Type -AssemblyName System.Windows.Forms; " +
        "$f = New-Object System.Windows.Forms.FolderBrowserDialog; " +
        "if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath } else { '' }";
      wslx.psExec(["-Command", ps], { timeout: 300000 }, (e, out) => {
        if (e) {
          res.writeHead(500);
          res.end(String(e.message));
          return;
        }
        const w = String(out || "").trim();
        picked(w ? wslx.toWslPath(w) || w : "");
      });
    } else {
      // Linux: zenity if installed. ENOENT → 404 (client falls back to in-house).
      execFile(
        "zenity",
        ["--file-selection", "--directory"],
        { timeout: 300000 },
        (e, out) => {
          if (e && e.code === "ENOENT") {
            res.writeHead(404);
            res.end("zenity not installed");
            return;
          }
          if (e) {
            res.writeHead(500);
            res.end(String(e.message));
            return;
          }
          picked(String(out || "").trim());
        },
      );
    }
  } else if (req.method === "POST" && req.url === "/places") {
    readBody(req, (body) => {
      try {
        const { name, folder, remove } = JSON.parse(body);
        const n = String(name || "")
          .trim()
          .slice(0, 40);
        if (!n) throw new Error("no name");
        if (remove) delete reg.places[n];
        else {
          if (!folder) throw new Error("no folder");
          reg.places[n] = String(folder).trim();
        }
        saveReg();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url === "/jobs") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ jobs }));
  } else if (req.method === "POST" && req.url === "/jobs") {
    // Create a standing work order: now / at (one-shot or daily) / every N.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        if (!p.agent || !reg.agents[p.agent] || p.agent === "ceo")
          throw new Error("bad agent");
        if (!p.prompt) throw new Error("no prompt");
        const job = {
          id: "j" + Date.now(),
          agent: p.agent,
          prompt: String(p.prompt).slice(0, 4000),
          mode: ["now", "at", "every"].includes(p.mode) ? p.mode : "now",
          at: Number(p.at) || 0,
          time: String(p.time || "").slice(0, 5),
          daily: !!p.daily,
          everyMin: Math.max(5, Number(p.everyMin) || 10), // floor: 5 min
          enabled: true,
          created: Date.now(),
        };
        jobs.push(job);
        saveJobs();
        if (job.mode === "now") dispatchJob(job);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: job.id }));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/jobs/update") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        const job = jobs.find((j) => j.id === p.id);
        if (!job) {
          res.writeHead(404);
          return res.end("unknown job");
        }
        if (p.remove) {
          jobs = jobs.filter((j) => j.id !== p.id);
        } else {
          if (p.enabled !== undefined) job.enabled = !!p.enabled;
          if (typeof p.prompt === "string" && p.prompt.trim())
            job.prompt = p.prompt.slice(0, 4000);
          if (p.agent && reg.agents[p.agent] && p.agent !== "ceo")
            job.agent = p.agent;
          if (p.everyMin !== undefined)
            job.everyMin = Math.max(5, Number(p.everyMin) || 10);
          if (typeof p.time === "string") job.time = p.time.slice(0, 5);
          if (p.daily !== undefined) job.daily = !!p.daily;
          if (p.at !== undefined) job.at = Number(p.at) || 0;
          // Re-scheduling a one-time 'at' that already fired re-arms it.
          if (p.at !== undefined || p.time !== undefined) {
            job.lastRun = 0;
            delete job.lastDay;
          }
        }
        saveJobs();
        broadcast({ type: "jobs.changed" }, false);
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url === "/office-md") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    try {
      res.end(fs.readFileSync(OFFICE_MD, "utf8"));
    } catch {
      res.end("");
    }
  } else if (req.method === "POST" && req.url === "/office-md") {
    readBody(req, (body) => {
      try {
        const { text } = JSON.parse(body);
        fs.writeFileSync(OFFICE_MD, String(text || "").slice(0, 64000));
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url === "/notes") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ notes }));
  } else if (req.method === "POST" && req.url === "/notes") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        if (p.remove) notes = notes.filter((n) => n.id !== p.remove);
        else if (p.edit) {
          const n = notes.find((x) => x.id === p.edit);
          if (!n) throw new Error("note not found");
          const txt = String(p.text || "")
            .trim()
            .slice(0, 500);
          if (!txt) throw new Error("empty");
          n.text = txt; // keep id/who/ts so the note stays in place
        } else if (p.text)
          notes.push({
            id: "n" + Date.now(),
            who: p.who || "you",
            text: String(p.text).slice(0, 500),
            ts: Date.now(),
          });
        else throw new Error("no text");
        saveNotes();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url === "/calendar") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ cal }));
  } else if (req.method === "POST" && req.url === "/calendar") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        if (p.remove) cal = cal.filter((c) => c.id !== p.remove);
        else if (p.edit) {
          const c = cal.find((x) => x.id === p.edit);
          if (!c) throw new Error("not found");
          if (p.title) c.title = String(p.title).slice(0, 120);
          if (p.at) {
            const at = Number(p.at) || Date.parse(p.at);
            if (at) {
              c.at = at;
              c.notified = false;
            }
          }
          if (p.remindMin !== undefined)
            c.remindMin = Math.max(1, Number(p.remindMin) || 10);
        } else {
          const at = Number(p.at) || Date.parse(p.at);
          if (!p.title || !at) throw new Error("need title + at");
          cal.push({
            id: "c" + Date.now(),
            title: String(p.title).slice(0, 120),
            at,
            remindMin: Math.max(1, Number(p.remindMin) || 10),
            notified: false,
          });
        }
        saveCal();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/registry/key") {
    // 🔑 API key vault: ENV_NAME → value, injected into every agent run's
    // environment (OPENAI_API_KEY, GEMINI_API_KEY, …). Agents are told the
    // NAMES via projectNote; values live only in registry.json + env.
    readBody(req, (body) => {
      try {
        const { name, value, remove } = JSON.parse(body);
        const n = String(name || "")
          .trim()
          .toUpperCase()
          .replace(/[^A-Z0-9_]/g, "_")
          .slice(0, 64);
        if (!n) throw new Error("no name");
        if (remove) delete reg.apiKeys[n];
        else {
          if (!value) throw new Error("no value");
          reg.apiKeys[n] = String(value).trim().slice(0, 500);
        }
        saveReg();
        pushRoster(); // feature gates flip live in every client
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url.startsWith("/proxy/")) {
    // 🧠 Built-in Anthropic↔OpenAI translator: claude (ANTHROPIC_BASE_URL →
    // /proxy/<provider>) posts here; we call OpenAI/Gemini with the user's main
    // key and translate the reply back (streaming + tool-use). See proxy.js.
    const prov = (req.url.split("/")[2] || "").split("?")[0];
    readBodyRaw(req, (raw) => {
      proxy.handle(req, res, prov, reg, raw).catch((e) => {
        try {
          if (!res.headersSent) {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                type: "error",
                error: { type: "api_error", message: String(e && e.message) },
              }),
            );
          } else {
            res.end();
          }
        } catch {}
      });
    });
  } else if (req.method === "POST" && req.url === "/registry/provider") {
    // 🧠 Swappable-brain credentials: per-provider token / baseUrl / model
    // overrides (glm/deepseek/qwen/minimax/litellm…). Values live only in
    // registry.json + the agent's spawn env — never sent to Anthropic.
    // Owner-only (handles secrets + brain config) — same boundary as /registry/agent.
    if (!req.headers["x-bagidea-ui"]) {
      res.writeHead(403);
      return res.end("human UI only");
    }
    readBody(req, (body) => {
      try {
        const { provider, token, baseUrl, model, kind, label, remove } =
          JSON.parse(body);
        if (!provider) throw new Error("provider required");
        reg.providerConfig = reg.providerConfig || {};
        if (remove) {
          delete reg.providerConfig[provider];
        } else {
          const c = reg.providerConfig[provider] || {};
          if (token !== undefined) {
            c.token = String(token).slice(0, 400);
            c.connected = false;
          }
          if (baseUrl !== undefined) {
            let b = String(baseUrl).slice(0, 300).trim();
            // Claude CLI appends /v1/messages itself — a user-supplied …/v1 doubles it → 405.
            // Strip for anthropic-kind; leave openai-kind alone (proxy handles its own pathing).
            const effectiveKind = kind || c.kind || "anthropic";
            if (effectiveKind !== "openai") {
              b = b.replace(/\/+$/, "").replace(/\/v1$/, "");
            }
            c.baseUrl = b;
          }
          if (model !== undefined) c.model = String(model).slice(0, 60);
          if (kind !== undefined)
            c.kind = kind === "openai" ? "openai" : "anthropic";
          if (label !== undefined) c.label = String(label).slice(0, 40);
          reg.providerConfig[provider] = c;
        }
        saveReg();
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/registry/provider/test") {
    // 🧪 Validate a provider's key (and, for openai/gemini, fetch its live model
    // list). Persists reg.providerConfig[p].connected so the UI shows the state.
    readBody(req, async (body) => {
      const done = (ok, msg, models) => {
        try {
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ ok, msg, models: models || null }));
        } catch {}
      };
      try {
        const { provider } = JSON.parse(body);
        reg.providerConfig = reg.providerConfig || {};
        const pc = reg.providerConfig[provider] || {};
        const spec = providers.PROVIDERS[provider];
        const kind = spec ? spec.format : pc.kind; // "anthropic" | "openai"
        if (!kind) return done(false, "この provider は不明です");
        const setConn = (ok, models) => {
          reg.providerConfig[provider] = reg.providerConfig[provider] || {};
          reg.providerConfig[provider].connected = ok;
          if (models) reg.providerConfig[provider].models = models;
          try {
            saveReg();
          } catch {}
        };
        const signal = AbortSignal.timeout
          ? AbortSignal.timeout(12000)
          : undefined;
        if (kind === "openai") {
          // OpenAI-compatible: GET /models validates the key + lists usable models.
          const { models: modelsUrl, key } = proxy.upstreamFor(provider, reg);
          if (!modelsUrl) return done(false, "endpoint が見つかりません");
          if (!key) return done(false, "key がまだ設定されていません");
          const r = await fetch(modelsUrl, {
            headers: { authorization: "Bearer " + key },
            signal,
          });
          if (r.ok) {
            let models = [];
            try {
              const j = await r.json();
              captureModelCtx(provider, j.data);
              models = proxy
                .cleanModels((j.data || []).map((m) => m.id))
                .slice(0, 300);
            } catch {}
            setConn(true, models);
            return done(true, "接続しました ✓", models);
          }
          setConn(false);
          return done(false, "key が通りません (HTTP " + r.status + ")");
        }
        // anthropic-compatible: a 1-token /v1/messages probe (401/403 = bad key).
        const base = pc.baseUrl || (spec && spec.baseUrl);
        if (!base) return done(false, "endpoint が見つかりません");
        if (!pc.token) return done(false, "key がまだ設定されていません");
        const model =
          pc.model || (spec && spec.models && spec.models.find(Boolean)) || "";
        const r = await fetch(base.replace(/\/+$/, "") + "/v1/messages", {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": pc.token,
            authorization: "Bearer " + pc.token,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
        });
        const authBad = r.status === 401 || r.status === 403; // bad key
        const pathBad = r.status === 404 || r.status === 405; // doubled /v1 or wrong endpoint
        // Best-effort: pull the provider's LIVE model list from its OpenAI-compatible
        // /models endpoint so the picker is always current (GLM/DeepSeek/Qwen/Moonshot…).
        // A failure here never blocks the connection — static hints + the free-type field
        // still work.
        let models = null;
        const murl = pc.modelsUrl || (spec && spec.modelsUrl);
        if (!authBad && !pathBad && murl) {
          try {
            const msig = AbortSignal.timeout
              ? AbortSignal.timeout(8000)
              : undefined;
            const mr = await fetch(murl, {
              headers: { authorization: "Bearer " + pc.token },
              signal: msig,
            });
            if (mr.ok) {
              const j = await mr.json();
              captureModelCtx(provider, j.data);
              models = proxy
                .cleanModels((j.data || []).map((m) => m.id))
                .slice(0, 300);
            }
          } catch {}
        }
        setConn(!authBad && !pathBad, models && models.length ? models : null);
        if (pathBad)
          return done(
            false,
            "endpoint が不正です (HTTP " +
              r.status +
              ") — baseUrl が /v1 で終わっているなら削除してください",
          );
        return done(
          !authBad,
          authBad
            ? "key が通りません (HTTP " + r.status + ")"
            : "接続しました ✓",
          models,
        );
      } catch (e) {
        return done(false, String((e && e.message) || e));
      }
    });
  } else if (req.method === "GET" && req.url === "/claude/auth") {
    // 🔓 Is Claude usable? Logged-in (credentials file / oauthAccount) OR API key set.
    const home = require("os").homedir();
    let loggedIn = false;
    try {
      loggedIn = fs.existsSync(path.join(home, ".claude", ".credentials.json"));
    } catch {}
    if (!loggedIn) {
      try {
        const j = JSON.parse(
          fs.readFileSync(path.join(home, ".claude.json"), "utf8"),
        );
        loggedIn = !!(j && (j.oauthAccount || j.userID));
      } catch {}
    }
    const viaKey = !!(reg.apiKeys && reg.apiKeys.ANTHROPIC_API_KEY);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ loggedIn, viaKey, connected: loggedIn || viaKey }),
    );
  } else if (req.method === "POST" && req.url === "/claude/login") {
    // 🔓 Open a terminal running `claude` so the user completes browser OAuth login.
    try {
      if (process.platform === "win32")
        spawn("cmd", ["/c", "start", "Claude Login", "cmd", "/k", "claude"], {
          detached: true,
        });
      else if (process.platform === "darwin")
        spawn(
          "osascript",
          ["-e", 'tell application "Terminal" to do script "claude"'],
          { detached: true },
        );
      else spawn("x-terminal-emulator", ["-e", "claude"], { detached: true });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.message));
    }
  } else if (req.method === "POST" && req.url === "/registry/channel") {
    // 🔗 channel connector config — saving restarts the connectors live.
    readBody(req, (body) => {
      try {
        const { kind, config } = JSON.parse(body);
        if (
          ![
            "telegram",
            "discord",
            "line",
            "slack",
            "whatsapp",
            "messenger",
          ].includes(kind)
        )
          throw new Error("bad kind");
        reg.channels[kind] = {
          enabled: !!(config && config.enabled),
          token: String((config && config.token) || "")
            .trim()
            .slice(0, 300),
          chat: String((config && config.chat) || "")
            .trim()
            .slice(0, 80),
          channel: String((config && config.channel) || "")
            .trim()
            .slice(0, 80),
          secret: String((config && config.secret) || "")
            .trim()
            .slice(0, 200),
          phone: String((config && config.phone) || "")
            .trim()
            .slice(0, 80), // WhatsApp phone number id
          verify: String((config && config.verify) || "")
            .trim()
            .slice(0, 200), // Meta webhook verify token
        };
        saveReg();
        channels.restart();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/upload") {
    // 📎 chat attachments → workspace/uploads (agents Read them by path).
    readBodyRaw(req, (buf) => {
      try {
        if (!buf.length) throw new Error("empty file");
        if (buf.length > 80 * 1024 * 1024)
          throw new Error("ファイルが 80MB を超えています");
        const raw = decodeURIComponent(
          String(req.headers["x-file-name"] || "file.bin"),
        );
        const safe = raw.replace(/[^\w.ก-๙ -]/g, "_").slice(-80);
        const dir = path.join(WORKSPACE, "uploads");
        fs.mkdirSync(dir, { recursive: true });
        const name = Date.now() + "_" + safe;
        const full = path.join(dir, name);
        fs.writeFileSync(full, buf);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(
          JSON.stringify({
            path: full,
            url: "/uploads/" + encodeURIComponent(name),
            name: safe,
          }),
        );
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url.startsWith("/uploads/")) {
    const name = decodeURIComponent(req.url.slice(9).split("?")[0]).replace(
      /[\\/]|\.\./g,
      "",
    );
    serveMedia(res, path.join(WORKSPACE, "uploads", name), req);
  } else if (req.method === "GET" && req.url.startsWith("/media?")) {
    // Render agent-produced or user-referenced media in chat from an absolute
    // path ANYWHERE on disk — people kept having to copy images into the
    // workspace just to see them, which defeats the point. <img> tags can't
    // send auth headers, so we can't gate this by the UI header; instead the
    // safety comes from serveMedia itself, which serves ONLY media MIME types
    // (image/video/audio/pdf) — never source, .env, keys, or arbitrary files —
    // and the daemon binds to localhost. So the worst a stray request can do is
    // display a media file, and cross-origin pages can't read its bytes back
    // (CORS + canvas taint). That's an acceptable trade for "media just shows".
    const p = new URL(req.url, "http://x").searchParams.get("p") || "";
    serveMedia(res, path.resolve(p), req);
  } else if (req.method === "POST" && req.url === "/reveal") {
    // Open the OS file manager at a file (like LINE/other messengers). UI-only,
    // and the target must live under the workspace or a registered project.
    if (!req.headers["x-bagidea-ui"]) {
      res.writeHead(403);
      return res.end("human UI only");
    }
    readBody(req, (body) => {
      try {
        let p = String((JSON.parse(body) || {}).path || "");
        if (p.startsWith("/uploads/"))
          p = path.join(
            WORKSPACE,
            "uploads",
            decodeURIComponent(p.slice(9)).replace(/[\\/]|\.\./g, ""),
          );
        p = path.resolve(p);
        // Reveal-in-folder just opens the OS file manager at a location — no file
        // is executed — and this route is UI-gated (x-bagidea-ui, CSRF-safe), so a
        // location anywhere on disk is fine. Lets the owner reveal media that lives
        // outside the workspace (the same files chat now previews from anywhere).
        if (!fs.existsSync(p)) {
          res.writeHead(404);
          return res.end("not found");
        }
        // explorer needs "/select," and the path as ONE argument or it ignores
        // the selection and opens Documents. spawn passes argv as-is (no shell),
        // so a single combined token is the reliable form (spaces included).
        if (process.platform === "win32")
          spawn("explorer.exe", ["/select," + p], { detached: true });
        else if (process.platform === "darwin")
          spawn("open", ["-R", p], { detached: true });
        else if (wslx.isWSL()) {
          // Hybrid: reveal in the WINDOWS Explorer via \\wsl.localhost.
          // Interop off (appendWindowsPath=false) → ENOENT → WSLg fallback.
          const w = wslx.toWinPath(p);
          if (w)
            spawn("explorer.exe", ["/select," + w], {
              detached: true,
              cwd: wslx.INTEROP_CWD,
            }).on("error", () =>
              spawn("xdg-open", [path.dirname(p)], { detached: true }).on(
                "error",
                () => {},
              ),
            );
          else spawn("xdg-open", [path.dirname(p)], { detached: true });
        } else spawn("xdg-open", [path.dirname(p)], { detached: true });
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/open") {
    // Open a file in the OS default app (image viewer, player, browser) — a real
    // separate, resizable window. Same UI-only + allowlist guard as /reveal.
    if (!req.headers["x-bagidea-ui"]) {
      res.writeHead(403);
      return res.end("human UI only");
    }
    readBody(req, (body) => {
      try {
        let p = String((JSON.parse(body) || {}).path || "");
        // An http(s) URL → open it in the system browser (office webviews can't follow
        // target=_blank, so links route here instead). Only http/https; nothing else.
        if (/^https?:\/\//i.test(p)) {
          if (process.platform === "win32")
            spawn("cmd", ["/c", "start", "", p], {
              detached: true,
              windowsHide: true,
            });
          else if (process.platform === "darwin")
            spawn("open", [p], { detached: true });
          else if (wslx.isWSL())
            spawn("cmd.exe", ["/c", "start", "", p], {
              detached: true,
              cwd: wslx.INTEROP_CWD,
            }).on("error", () =>
              spawn("xdg-open", [p], { detached: true }).on("error", () => {}),
            );
          else spawn("xdg-open", [p], { detached: true });
          res.writeHead(200);
          return res.end("ok");
        }
        if (p.startsWith("/uploads/"))
          p = path.join(
            WORKSPACE,
            "uploads",
            decodeURIComponent(p.slice(9)).replace(/[\\/]|\.\./g, ""),
          );
        p = path.resolve(p);
        // "Open in default app" launches the file, so be stricter than chat preview
        // / reveal: files under the workspace or a registered project may open as
        // anything (a project .html, a report .txt…), but a path OUTSIDE those roots
        // is only opened when it's a media file. That lets people pop external images/
        // video out to a real viewer, without this becoming a way to run an arbitrary
        // .exe/.bat/.ps1 sitting elsewhere on disk.
        const roots = [
          path.resolve(WORKSPACE),
          ...projects.map((x) => path.resolve(x.dir)),
        ];
        const underRoot = roots.some(
          (r) =>
            p.toLowerCase() === r.toLowerCase() ||
            p.toLowerCase().startsWith(r.toLowerCase() + path.sep),
        );
        if (!underRoot && !isMediaPath(p)) {
          res.writeHead(403);
          return res.end("outside allowed roots");
        }
        if (!fs.existsSync(p)) {
          res.writeHead(404);
          return res.end("not found");
        }
        if (process.platform === "win32")
          spawn("cmd", ["/c", "start", "", p], {
            detached: true,
            windowsHide: true,
          });
        else if (process.platform === "darwin")
          spawn("open", [p], { detached: true });
        else if (wslx.isWSL()) {
          // Hybrid: open in the WINDOWS default app via \\wsl.localhost.
          const w = wslx.toWinPath(p);
          if (w)
            spawn("cmd.exe", ["/c", "start", "", w], {
              detached: true,
              cwd: wslx.INTEROP_CWD,
            }).on("error", () =>
              spawn("xdg-open", [p], { detached: true }).on("error", () => {}),
            );
          else spawn("xdg-open", [p], { detached: true });
        } else spawn("xdg-open", [p], { detached: true });
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url === "/layout") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    try {
      res.end(fs.readFileSync(LAYOUT_FILE, "utf8"));
    } catch {
      res.end(JSON.stringify({ items: [] }));
    }
  } else if (req.method === "GET" && req.url === "/assets") {
    // 🗂 imported model/image library — reusable across editor sessions.
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    try {
      res.end(fs.readFileSync(ASSETS_FILE, "utf8"));
    } catch {
      res.end(JSON.stringify({ assets: [] }));
    }
  } else if (req.method === "POST" && req.url === "/assets") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        let assets = [];
        try {
          assets =
            JSON.parse(fs.readFileSync(ASSETS_FILE, "utf8")).assets || [];
        } catch {}
        if (p.remove) assets = assets.filter((a) => a.path !== p.remove);
        else {
          const path_ = String(p.path || "").trim();
          const kind = p.kind === "image" ? "image" : "model";
          if (!path_) throw new Error("no path");
          if (!assets.some((a) => a.path === path_))
            assets.push({
              path: path_,
              kind,
              name: path_.split(/[\\/]/).pop(),
              ts: Date.now(),
            });
        }
        fs.writeFileSync(ASSETS_FILE, JSON.stringify({ assets }, null, 1));
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url === "/presets") {
    // custom layout presets the user saved from the 3D editor (defaults live
    // in the editor itself).
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    try {
      res.end(fs.readFileSync(PRESETS_FILE, "utf8"));
    } catch {
      res.end(JSON.stringify({ presets: [] }));
    }
  } else if (req.method === "POST" && req.url === "/presets") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        let presets = [];
        try {
          presets =
            JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8")).presets || [];
        } catch {}
        if (p.remove) presets = presets.filter((x) => x.name !== p.remove);
        else {
          const name = String(p.name || "")
            .trim()
            .slice(0, 40);
          if (!name || !Array.isArray(p.items))
            throw new Error("need name + items");
          presets = presets.filter((x) => x.name !== name); // overwrite same name
          presets.push({ name, items: p.items.slice(0, 500), ts: Date.now() });
        }
        fs.writeFileSync(PRESETS_FILE, JSON.stringify({ presets }, null, 1));
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/layout") {
    // 🎨 Office Editor saves the whole layout; the world re-applies it live.
    readBody(req, (body) => {
      try {
        const j = JSON.parse(body);
        if (!Array.isArray(j.items)) throw new Error("items must be an array");
        const out = { items: j.items.slice(0, 500) };
        if (Array.isArray(j.rooms)) out.rooms = j.rooms.slice(0, 64); // jigsaw room arrangement
        if (Array.isArray(j.ghost) && j.ghost.length === 2)
          out.ghost = j.ghost.map(Number); // ghost deck pos
        if (typeof j.billboard === "string" && j.billboard)
          out.billboard = j.billboard.slice(0, 400); // custom sign image
        fs.writeFileSync(LAYOUT_FILE, JSON.stringify(out, null, 1));
        broadcast({ type: "layout.changed" }, false);
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url === "/plugins") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ plugins: plugins.list() }));
  } else if (req.method === "POST" && req.url === "/plugins/reload") {
    // load() syntax-checks every index.js (node --check) before require(), so a
    // JS-broken plugin is rejected with a clear parser error instead of crashing
    // silently. Report failures explicitly — a reload that dropped a plugin is
    // NOT a plain "ok".
    const result = plugins.load();
    broadcast({ type: "plugins.changed" }, false);
    if (result && result.failed && result.failed.length) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: false,
          loaded: result.loaded,
          failed: result.failed,
        }),
      );
    } else {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, loaded: result ? result.loaded : 0 }));
    }
  } else if (req.method === "POST" && req.url === "/editor/open") {
    // 🎨 Ask the shell to open the editor — it shows its circular logo splash,
    // launches Godot tiny+cloaked behind it, and reveals when ready (the SAME
    // boot path as the wallpaper). Falls back to a direct launch if no shell.
    try {
      const tmp = require("os").tmpdir();
      try {
        fs.unlinkSync(path.join(tmp, "bagidea_editor_ready"));
      } catch {}
      fs.writeFileSync(
        path.join(tmp, "bagidea_editor_open_request"),
        String(Date.now()),
      );
      // Hybrid: the WINDOWS shell watches the WINDOWS temp dir for these
      // flags — mirror them there (drvfs write), or the editor never opens.
      const winTmp = wslx.isWSL() ? wslx.winTempDir() : null;
      if (winTmp) {
        try {
          fs.unlinkSync(path.join(winTmp, "bagidea_editor_ready"));
        } catch {}
        try {
          fs.writeFileSync(
            path.join(winTmp, "bagidea_editor_open_request"),
            String(Date.now()),
          );
        } catch {}
      }
      // fallback: if the shell isn't running, launch directly after a beat
      const gdir = path.join(__dirname, "..", "godot");
      let godot = "";
      if (process.platform === "win32") {
        const branded = path.join(gdir, "bin", "BagIdeaOffice.exe");
        godot = fs.existsSync(branded)
          ? branded
          : process.env.BAGIDEA_GODOT ||
            "C:\\Program Files\\Godot\\Godot_v4.6.3-stable_win64.exe";
      } else if (process.platform === "darwin") {
        const app = path.join(
          gdir,
          "bin-mac",
          "Godot.app",
          "Contents",
          "MacOS",
          "Godot",
        );
        godot = fs.existsSync(app) ? app : "Godot";
      } else {
        // Linux/other: a bundled binary under godot/bin-linux/, else $BAGIDEA_GODOT,
        // else rely on `godot` on PATH (installed by install-linux.sh).
        const bin = path.join(gdir, "bin-linux", "godot");
        godot = fs.existsSync(bin) ? bin : process.env.BAGIDEA_GODOT || "godot";
      }
      const shellUp =
        fs.existsSync(path.join(tmp, "bagidea_shell_alive")) ||
        (winTmp
          ? fs.existsSync(path.join(winTmp, "bagidea_shell_alive"))
          : false);
      if (!shellUp && fs.existsSync(godot)) {
        spawn(godot, ["--path", gdir, "--", "--editor3d"], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        }).unref();
      }
      broadcast({ type: "editor.opening" }, false);
      res.writeHead(200);
      res.end("ok");
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.message));
    }
  } else if (req.method === "POST" && req.url === "/plugins/install") {
    // 📦 one-click install: git clone a plugin repo into plugins/ then reload.
    readBody(req, (body) => {
      try {
        if (!req.headers["x-bagidea-ui"]) {
          res.writeHead(403);
          return res.end("human UI only");
        }
        const reqBody = JSON.parse(body);
        let url = String(reqBody.url || "").trim();
        const mode = String(reqBody.mode || ""); // "" → ask on conflict · "overwrite" · "new"
        if (
          !/^https:\/\/(github\.com|gitlab\.com|[\w.-]+)\/[\w.\-/]+$/.test(url)
        )
          throw new Error(
            "plugin の https:// で始まる git repo のリンクを入力してください",
          );
        if (!url.endsWith(".git")) url += ".git";
        // Clone into a temp folder first, then move it to plugins/<id> using
        // the id from its OWN manifest — so the install folder always matches
        // the plugin id (remove + core protection look it up by id).
        const pluginsRoot = path.join(__dirname, "..", "plugins");
        const tmp = path.join(pluginsRoot, ".installing-" + Date.now());
        const { execFile } = require("child_process");
        execFile(
          "git",
          ["clone", "--depth", "1", url, tmp],
          { timeout: 60000 },
          (e) => {
            const fail = (msg) => {
              try {
                fs.rmSync(tmp, { recursive: true, force: true });
              } catch {}
              res.writeHead(400, {
                "content-type": "text/plain; charset=utf-8",
              });
              res.end(msg);
            };
            if (e || !fs.existsSync(path.join(tmp, "plugin.json")))
              return fail(
                e
                  ? "clone に失敗しました：" + e.message
                  : "この repo に plugin.json がありません — 正しい plugin ではありません",
              );
            let man = {};
            try {
              man = JSON.parse(
                fs.readFileSync(path.join(tmp, "plugin.json"), "utf8"),
              );
            } catch {}
            const repoName = url
              .split("/")
              .pop()
              .replace(/\.git$/, "");
            const id = String(man.id || repoName).replace(/[^\w-]/g, "");
            if (!id) return fail("plugin.json に正しい id がありません");
            let finalId = id;
            let dest = path.join(pluginsRoot, id);
            if (fs.existsSync(dest)) {
              if (mode === "overwrite") {
                try {
                  fs.rmSync(dest, { recursive: true, force: true });
                } catch (err) {
                  return fail("既存のものの削除に失敗しました：" + err.message);
                }
              } else if (mode === "new") {
                // Install a SECOND copy under a free id (foo-2, foo-3…) and rewrite the
                // manifest id/name to match, so it's a genuinely distinct plugin.
                let n = 2;
                while (fs.existsSync(path.join(pluginsRoot, id + "-" + n))) n++;
                finalId = id + "-" + n;
                dest = path.join(pluginsRoot, finalId);
                try {
                  man.id = finalId;
                  if (man.name) man.name = man.name + " (" + n + ")";
                  fs.writeFileSync(
                    path.join(tmp, "plugin.json"),
                    JSON.stringify(man, null, 2),
                  );
                } catch (err) {
                  return fail("新しい名前の設定に失敗しました：" + err.message);
                }
              } else {
                // No decision yet → let the UI ask the owner (overwrite vs new copy).
                try {
                  fs.rmSync(tmp, { recursive: true, force: true });
                } catch {}
                res.writeHead(409, {
                  "content-type": "application/json; charset=utf-8",
                });
                return res.end(JSON.stringify({ exists: true, id }));
              }
            }
            try {
              fs.renameSync(tmp, dest);
            } catch (err) {
              return fail("インストールに失敗しました：" + err.message);
            }
            plugins.load();
            broadcast({ type: "plugins.changed" }, false);
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
            });
            res.end(JSON.stringify({ ok: true, name: finalId }));
          },
        );
      } catch (e) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/plugins/intent") {
    // A bagidea:// deep link (from the web Plugins page) asking to install a
    // plugin. We do NOT install here — we broadcast an intent so the OFFICE asks
    // the user to confirm first. A web page must never silently install code.
    readBody(req, (body) => {
      try {
        if (!req.headers["x-bagidea-ui"]) {
          res.writeHead(403);
          return res.end("human UI only");
        }
        let repo = String(JSON.parse(body || "{}").repo || "").trim();
        if (
          !/^https:\/\/(github\.com|gitlab\.com|[\w.-]+)\/[\w.\-/]+$/.test(repo)
        )
          throw new Error("bad repo url");
        broadcast({ type: "plugin.intent", repo }, false);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/plugins/remove") {
    readBody(req, (body) => {
      try {
        if (!req.headers["x-bagidea-ui"]) {
          res.writeHead(403);
          return res.end("human UI only");
        }
        const id = String(JSON.parse(body).id || "").replace(/[^\w-]/g, "");
        const dir = plugins.dirOf(id); // by manifest id — folder name may differ
        const manFile = dir && path.join(dir, "plugin.json");
        if (!dir || !fs.existsSync(manFile))
          throw new Error("plugin が見つかりません");
        // Core plugins ship with the office and can't be uninstalled; only
        // plugins the user added (e.g. via GitHub) are removable.
        let man = {};
        try {
          man = JSON.parse(fs.readFileSync(manFile, "utf8"));
        } catch {}
        if (man.core) throw new Error("コア plugin は削除できません");
        fs.rmSync(dir, { recursive: true, force: true });
        plugins.load();
        broadcast({ type: "plugins.changed" }, false);
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/plugins/check-updates") {
    // 🔄 For every git-installed plugin, compare local HEAD to the remote's HEAD
    // — read-only (`git ls-remote`, no fetch) — and report which ones are behind.
    if (!req.headers["x-bagidea-ui"]) {
      res.writeHead(403);
      return res.end("human UI only");
    }
    (async () => {
      const pexec = require("util").promisify(
        require("child_process").execFile,
      );
      const pluginsRoot = path.join(__dirname, "..", "plugins");
      const out = {};
      await Promise.all(
        plugins.list().map(async (p) => {
          if (p.core) return;
          const dir = plugins.dirOf(p.id); // by manifest id — folder name may differ
          if (!dir || !fs.existsSync(path.join(dir, ".git"))) return;
          try {
            const opt = { cwd: dir, timeout: 12000 };
            // Only shallow clones are Hub-installed (depth 1, never developed in).
            // A FULL clone is a dev's own working repo (e.g. waxwing) — never flag it,
            // so a one-click "update" can't discard their unpushed commits.
            const shallow = (
              await pexec("git", ["rev-parse", "--is-shallow-repository"], opt)
            ).stdout.trim();
            if (shallow !== "true") return;
            const local = (
              await pexec("git", ["rev-parse", "HEAD"], opt)
            ).stdout.trim();
            const ls = (
              await pexec("git", ["ls-remote", "origin", "HEAD"], opt)
            ).stdout.trim();
            const remote = ls.split(/\s+/)[0] || "";
            if (remote && remote !== local) out[p.id] = true;
          } catch {
            /* offline / no remote → just don't flag it */
          }
        }),
      );
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ updates: out }));
    })();
  } else if (req.method === "POST" && req.url === "/plugins/update") {
    // ⬆ Update one plugin: git fetch + reset --hard to the remote HEAD, then reload.
    // Guarded — refuses if the working tree is dirty, so it can never clobber a
    // dev's own plugin checkout with uncommitted work (e.g. the canonical waxwing).
    readBody(req, (body) => {
      if (!req.headers["x-bagidea-ui"]) {
        res.writeHead(403);
        return res.end("human UI only");
      }
      const { execFile } = require("child_process");
      try {
        const id = String(JSON.parse(body).id || "").replace(/[^\w-]/g, "");
        const dir = plugins.dirOf(id); // by manifest id — folder name may differ
        const manFile = dir && path.join(dir, "plugin.json");
        if (!dir || !fs.existsSync(manFile))
          throw new Error("plugin が見つかりません");
        let man = {};
        try {
          man = JSON.parse(fs.readFileSync(manFile, "utf8"));
        } catch {}
        if (man.core)
          throw new Error(
            "コア plugin はアプリ本体から更新します。ここではありません",
          );
        if (!fs.existsSync(path.join(dir, ".git")))
          throw new Error(
            "この plugin は git からインストールされていません — 自動更新できません",
          );
        const fail = (m) => {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end(m);
        };
        const opt = { cwd: dir, timeout: 60000 };
        execFile(
          "git",
          ["rev-parse", "--is-shallow-repository"],
          opt,
          (e0, sh) => {
            if (e0) return fail("git error: " + e0.message);
            // Full clone = a dev's own working repo → auto-update is disabled so a
            // fetch+reset can never throw away unpushed commits. (Hub installs are shallow.)
            if (String(sh).trim() !== "true")
              return fail(
                "この plugin は自分で開発している repo（full clone）です — 作業消失を防ぐため自動更新を無効にしています",
              );
            execFile("git", ["status", "--porcelain"], opt, (e1, so) => {
              if (e1) return fail("git error: " + e1.message);
              if (String(so).trim())
                return fail(
                  "この plugin に未 commit のファイルがあります — 上書き更新しません（作業消失を防ぐため）",
                );
              execFile(
                "git",
                ["fetch", "--depth", "1", "origin", "HEAD"],
                opt,
                (e2) => {
                  if (e2) return fail("fetch に失敗しました：" + e2.message);
                  execFile(
                    "git",
                    ["reset", "--hard", "FETCH_HEAD"],
                    opt,
                    (e3) => {
                      if (e3)
                        return fail("update に失敗しました：" + e3.message);
                      plugins.load();
                      broadcast({ type: "plugins.changed" }, false);
                      let v = "?";
                      try {
                        v =
                          JSON.parse(fs.readFileSync(manFile, "utf8"))
                            .version || "?";
                      } catch {}
                      res.writeHead(200, {
                        "content-type": "application/json; charset=utf-8",
                      });
                      res.end(JSON.stringify({ ok: true, version: v }));
                    },
                  );
                },
              );
            });
          },
        );
      } catch (e) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end(String(e.message));
      }
    });
  } else if (
    req.url.startsWith("/plugin/") &&
    plugins.handleHttp(req, res, readBody, readBodyRaw)
  ) {
    /* handled by a plugin */
  } else if (req.method === "POST" && req.url === "/registry/key/test") {
    // 🧪 verify a main key actually works (a tiny authenticated call).
    readBody(req, (body) => {
      try {
        const { name } = JSON.parse(body);
        const val = (reg.apiKeys || {})[name];
        if (!val) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({ ok: false, msg: "key がまだ設定されていません" }),
          );
        }
        const done = (ok, msg) => {
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ ok, msg }));
        };
        const https = require("https");
        if (name === "OPENAI_API_KEY") {
          const rq = https.request(
            {
              method: "GET",
              host: "api.openai.com",
              path: "/v1/models",
              headers: { authorization: "Bearer " + val },
            },
            (rs) => {
              rs.resume();
              done(
                rs.statusCode === 200,
                rs.statusCode === 200
                  ? "使えます ✓"
                  : "key が通りません (HTTP " + rs.statusCode + ")",
              );
            },
          );
          rq.setTimeout(12000, () => rq.destroy(new Error("timeout")));
          rq.on("error", (e) => done(false, e.message));
          rq.end();
        } else if (name === "GEMINI_API_KEY") {
          const rq = https.request(
            {
              method: "GET",
              host: "generativelanguage.googleapis.com",
              path: "/v1beta/models?key=" + val,
            },
            (rs) => {
              rs.resume();
              done(
                rs.statusCode === 200,
                rs.statusCode === 200
                  ? "使えます ✓"
                  : "key が通りません (HTTP " + rs.statusCode + ")",
              );
            },
          );
          rq.setTimeout(12000, () => rq.destroy(new Error("timeout")));
          rq.on("error", (e) => done(false, e.message));
          rq.end();
        } else done(true, "設定しました");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url === "/features") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(featuresMap()));
  } else if (req.method === "GET" && req.url === "/version") {
    // Local vs latest-released version (the VERSION file on main).
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        version: APP_VERSION,
        latest: latestVersion,
        updateAvailable: semverGt(latestVersion, APP_VERSION),
      }),
    );
  } else if (req.method === "GET" && req.url === "/startup") {
    // Is the app set to launch with Windows? (HKCU Run key, same one the tray
    // checkbox writes — so tray, CLI and settings stay in sync.)
    isAutostart((on) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ on }));
    });
  } else if (req.method === "POST" && req.url === "/startup") {
    if (!req.headers["x-bagidea-ui"]) {
      res.writeHead(403);
      return res.end("human UI only");
    }
    readBody(req, (body) => {
      try {
        const on = !!JSON.parse(body || "{}").on;
        setAutostart(on, (ok) => {
          res.writeHead(ok ? 200 : 500, { "content-type": "application/json" });
          res.end(JSON.stringify({ on: ok ? on : null }));
        });
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url === "/stats") {
    // 📊 dashboard: last 7 days of run stats + live system facts.
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      days.push({
        day: d,
        ...(stats[d] || { runs: 0, done: 0, failed: 0, cost: 0, agents: {} }),
      });
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        days,
        uptimeSec: Math.floor(process.uptime()),
        clients: wsClients.size,
        pendingPerms: pendingPerms.size,
        jobs: jobs.filter((j) => !j.done && j.enabled !== false).length,
        notes: notes.length,
        events: cal.filter((c) => c.at > Date.now()).length,
        channels: channels.status(),
        features: featuresMap(),
        projects: projectStatus().map((p) => ({
          name: p.name,
          ai: p.ai,
          open: p.open,
        })),
      }),
    );
  } else if (req.method === "GET" && req.url === "/channels/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(channels.status()));
  } else if (req.method === "POST" && req.url === "/channels/line/webhook") {
    // LINE Messaging API webhook — point your channel's webhook URL here
    // through a public HTTPS tunnel (e.g. cloudflared).
    readBodyRaw(req, (raw) => channels.lineWebhook(req, res, raw));
  } else if (
    req.method === "POST" &&
    req.url.split("?")[0] === "/channels/slack/webhook"
  ) {
    // Slack Events API webhook (public HTTPS tunnel; same as LINE).
    readBodyRaw(req, (raw) => channels.slackWebhook(req, res, raw));
  } else if (req.url.split("?")[0] === "/channels/whatsapp/webhook") {
    // WhatsApp Cloud API webhook — GET verifies the URL, POST delivers messages.
    if (req.method === "GET") channels.whatsappWebhook(req, res, null);
    else readBodyRaw(req, (raw) => channels.whatsappWebhook(req, res, raw));
  } else if (req.url.split("?")[0] === "/channels/messenger/webhook") {
    // Messenger (Meta Graph) webhook — GET verifies, POST delivers.
    if (req.method === "GET") channels.messengerWebhook(req, res, null);
    else readBodyRaw(req, (raw) => channels.messengerWebhook(req, res, raw));
  } else if (req.method === "POST" && req.url === "/registry/heartbeat") {
    // Director overview cadence: 0 = off, otherwise minutes between passes.
    readBody(req, (body) => {
      try {
        reg.heartbeatMin = Math.max(0, Number(JSON.parse(body).min) || 0);
        saveReg();
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
  } else if (req.method === "POST" && req.url === "/registry/sound") {
    // World sound effects on/off (persisted + live ui.sound broadcast).
    readBody(req, (body) => {
      try {
        reg.sound = !!JSON.parse(body).enabled;
        saveReg();
        pushRoster();
        broadcast({ type: "ui.sound", on: reg.sound });
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
  } else if (req.method === "POST" && req.url === "/registry/verify") {
    // 🔍 Verify delegated work before it reports to the CEO (opt-in, default off).
    readBody(req, (body) => {
      try {
        reg.verifyDelegated = !!JSON.parse(body).enabled;
        saveReg();
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
  } else if (req.method === "POST" && req.url === "/registry/autoskills") {
    readBody(req, (body) => {
      try {
        reg.autoSkills = !!JSON.parse(body).enabled;
        saveReg();
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
  } else if (req.method === "POST" && req.url === "/registry/role") {
    readBody(req, (body) => {
      try {
        const { name, remove } = JSON.parse(body);
        const n = String(name || "")
          .trim()
          .slice(0, 40);
        if (!n) throw new Error("no name");
        if (remove) reg.roles = reg.roles.filter((r) => r !== n);
        else if (!reg.roles.includes(n)) reg.roles.push(n);
        saveReg();
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/assist/prompt") {
    // ✨ Persona copilot: the owner types a one-line brief ("UI designer who
    // sweats microcopy") and a quick claude call drafts the whole persona —
    // AND picks the skills + tools that fit the role from what's available.
    readBody(req, async (body) => {
      try {
        const {
          name = "Agent",
          role = "Specialist",
          brief = "",
        } = JSON.parse(body);
        const skillMenu = Object.entries(reg.skills)
          .map(([id, s]) => `  ${id}: ${s.description || s.name || id}`)
          .join("\n");
        const toolMenu = Object.entries(BUILTIN_TOOLS)
          .map(([id, d]) => `  ${id}: ${d}`)
          .join("\n");
        const skillIds = Object.keys(reg.skills);
        const toolIds = Object.keys(BUILTIN_TOOLS);
        // Draft with the Director's (main agent's) brain — predictable, and it
        // works for an office with no Claude key (whatever provider the Director runs).
        const director = (reg.agents || {}).main;
        const draft = await claudeText(
          `Design a complete persona for an AI agent in a software office, and ` +
            `pick the skills + tools that fit its job.\n` +
            `Agent name: ${name}\nJob title: ${role}\nOwner's brief: ${brief}\n\n` +
            `Available SKILLS (pick by id, only ones that truly fit the role):\n${skillMenu}\n\n` +
            `Available TOOLS (pick by exact name, only what the job needs — fewer is better; ` +
            `a manager/coordinator needs very few, a builder needs more):\n${toolMenu}\n\n` +
            `Output STRICT JSON only (no markdown fences):\n` +
            `{"prompt":"core mission & identity, second person, 3-6 sentences",` +
            `"expertise":"bullet-ish lines: concrete skills, tools, domains they own",` +
            `"personality":"tone of voice, character quirks, how they talk",` +
            `"language":"primary reply language, e.g. 日本語 / English / ユーザーに合わせる",` +
            `"rules":"3-6 imperative work rules (do/don't), one per line",` +
            `"skills":["skill-id", ...],` +
            `"tools":["ToolName", ...]}\n` +
            `Every field must genuinely reflect the brief. skills/tools MUST be chosen ` +
            `ONLY from the lists above (exact ids/names). Match the brief's language ` +
            `(Thai brief → Thai text fields; skill ids and tool names stay verbatim).`,
          {
            provider: director && director.provider,
            model: director && director.model,
          },
        );
        let out = { prompt: draft };
        const m = draft.match(/\{[\s\S]*\}/);
        if (m)
          try {
            out = JSON.parse(m[0]);
          } catch {}
        // Keep only ids/names that actually exist — never invent capabilities.
        if (Array.isArray(out.skills))
          out.skills = out.skills.filter((s) => skillIds.includes(s));
        if (Array.isArray(out.tools))
          out.tools = out.tools.filter((t) => toolIds.includes(t));
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/ui/daylight") {
    // Manual atmosphere override for the world ("auto" follows the clock).
    // Persisted in the registry + carried on roster.sync, so the choice
    // survives renderer restarts/reconnects (journal replay alone is bounded by
    // REPLAY_COUNT and silently scrolls the pick out on a busy office).
    readBody(req, (body) => {
      try {
        const { hour = "auto" } = JSON.parse(body || "{}");
        reg.daylight = hour;
        saveReg();
        broadcast({ type: "ui.daylight", hour }, false);
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
  } else if (req.method === "POST" && req.url === "/ui/monitor") {
    // Which monitor the wallpaper runs on (multi-monitor). The shell reads
    // daemon/monitor.txt at attach time (0 = primary). Changing it auto-restarts
    // the office so it re-attaches to the chosen screen — no manual `bagidea
    // restart`. `noRestart:true` just records the choice (used by tests).
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body || "{}");
        const idx = Math.max(0, parseInt(p.index, 10) || 0);
        reg.monitor = idx;
        saveReg();
        fs.writeFileSync(path.join(__dirname, "monitor.txt"), String(idx));
        // Hybrid: the shell reads monitor.txt from the WINDOWS clone's
        // daemon/ dir (its own root) — mirror the choice there too.
        try {
          const g = wslx.guiRoot();
          if (g)
            fs.writeFileSync(
              path.join(g, "daemon", "monitor.txt"),
              String(idx),
            );
        } catch {}
        broadcast({ type: "ui.monitor", index: idx }, false);
        res.writeHead(200);
        res.end("ok");
        // Give the response a beat to flush, then relaunch the stack.
        if (!p.noRestart) setTimeout(triggerRestart, 350);
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
  } else if (req.method === "POST" && req.url === "/ui/restart") {
    // Manual "restart the office" (tray menu / overlay). Detached relaunch.
    if (!req.headers["x-bagidea-ui"]) {
      res.writeHead(403);
      return res.end("human UI only");
    }
    res.writeHead(200);
    res.end("ok");
    setTimeout(triggerRestart, 350);
  } else if (req.method === "POST" && req.url === "/ui/monitors") {
    // The shell reports the REAL monitor count it detected at attach. Persist it
    // (monitors.txt) + broadcast so the picker shows the right number, live.
    readBody(req, (body) => {
      try {
        const n = Math.max(
          1,
          parseInt(JSON.parse(body || "{}").count, 10) || 1,
        );
        fs.writeFileSync(path.join(__dirname, "monitors.txt"), String(n));
        broadcast({ type: "ui.monitors", count: n }, false);
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
  } else if (req.method === "GET" && req.url === "/workflows") {
    // Bundled read-only examples (daemon/workflow-examples) + the user's own
    // workflows (workspace/workflows). Examples can't be edited/deleted.
    const out = [];
    const scan = (base, example) => {
      try {
        for (const f of fs.readdirSync(base)) {
          if (!f.endsWith(".json")) continue;
          try {
            const w = JSON.parse(fs.readFileSync(path.join(base, f), "utf8"));
            out.push({
              id: w.id || f.replace(/\.json$/, ""),
              name: w.name || f,
              nodes: (w.nodes || []).length,
              example,
            });
          } catch {}
        }
      } catch {}
    };
    scan(path.join(__dirname, "workflow-examples"), true);
    scan(path.join(WORKSPACE, "workflows"), false);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  } else if (req.method === "GET" && req.url.startsWith("/workflows/get")) {
    const id = (
      new URL(req.url, "http://x").searchParams.get("id") || ""
    ).replace(/[^\w-]/g, "");
    if (id.startsWith("example-")) {
      try {
        const ex = path.join(__dirname, "workflow-examples");
        for (const f of fs.readdirSync(ex)) {
          if (!f.endsWith(".json")) continue;
          const raw = fs.readFileSync(path.join(ex, f), "utf8");
          try {
            if (JSON.parse(raw).id === id) {
              res.writeHead(200, { "content-type": "application/json" });
              return res.end(raw);
            }
          } catch {}
        }
      } catch {}
      res.writeHead(404);
      return res.end("{}");
    }
    try {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(fs.readFileSync(path.join(WORKSPACE, "workflows", id + ".json")));
    } catch {
      res.writeHead(404);
      res.end("{}");
    }
  } else if (req.method === "POST" && req.url === "/workflows/save") {
    readBody(req, (body) => {
      try {
        const w = JSON.parse(body || "{}");
        let id = String(w.id || "").replace(/[^\w-]/g, "");
        // Never overwrite a read-only example — saving one forks a new user copy.
        if (!id || id.startsWith("example-")) id = "wf_" + Date.now();
        const dir = path.join(WORKSPACE, "workflows");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, id + ".json"),
          JSON.stringify(
            {
              id,
              name: w.name || "Workflow",
              nodes: w.nodes || [],
              edges: w.edges || [],
            },
            null,
            2,
          ),
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id }));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/workflows/delete") {
    readBody(req, (body) => {
      try {
        const id = String(JSON.parse(body || "{}").id || "").replace(
          /[^\w-]/g,
          "",
        );
        if (id && !id.startsWith("example-"))
          fs.unlinkSync(path.join(WORKSPACE, "workflows", id + ".json"));
      } catch {}
      res.writeHead(200);
      res.end("ok");
    });
  } else if (req.method === "POST" && req.url === "/workflows/analyze") {
    // The Director reads the human-language workflow and returns a plan (which
    // skills/tools/agents/permissions it needs). P1: plan only, never auto-runs.
    readBody(req, (body) => {
      try {
        const w = JSON.parse(body || "{}");
        queueDirectorTurn((release) => {
          runClaude(
            "main",
            WORKFLOW_ANALYZE_PROMPT + "\n\n" + workflowToText(w),
            {
              logPrompt: "🔀 workflow を分析: " + (w.name || ""),
              onDone: (out, ok) => {
                release();
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({
                    ok: !!ok,
                    analysis:
                      ok && out
                        ? out
                        : "分析に失敗しました。もう一度お試しください",
                  }),
                );
              },
            },
          );
        });
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/workflows/draft") {
    // 🪄 Director drafts a workflow from a plain-language goal → returns Builder nodes
    // the owner can edit. (Approach C — the reverse of analyze.)
    readBody(req, (body) => {
      try {
        const goal = String(JSON.parse(body || "{}").goal || "").slice(0, 800);
        if (!goal.trim()) {
          res.writeHead(400);
          return res.end('{"ok":false}');
        }
        queueDirectorTurn((release) => {
          runClaude(
            "main",
            `Draft a workflow for this goal:\n"""${goal}"""\n\n` +
              `Reply with ONLY a JSON object, no prose: ` +
              `{"name":"<short title>","steps":["<step 1>","<step 2>", ...]}. ` +
              `3–8 short imperative steps in order, in the language of the goal.`,
            {
              noSub: true,
              logPrompt: "🪄 workflow を下書き: " + goal.slice(0, 40),
              onDone: (out, ok) => {
                release();
                let wf = null;
                try {
                  const m = String(out || "").match(/\{[\s\S]*\}/);
                  const j = m ? JSON.parse(m[0]) : null;
                  if (j && Array.isArray(j.steps) && j.steps.length)
                    wf = buildWorkflowFromSteps(
                      j.name || goal.slice(0, 40),
                      j.steps,
                    );
                } catch {}
                // Fallback: treat non-empty reply lines as steps so we never come back empty.
                if (!wf && ok && out) {
                  const lines = String(out)
                    .split("\n")
                    .map((l) =>
                      l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim(),
                    )
                    .filter(Boolean);
                  if (lines.length)
                    wf = buildWorkflowFromSteps(
                      goal.slice(0, 40),
                      lines.slice(0, 8),
                    );
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: !!wf, workflow: wf }));
              },
            },
          );
        });
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/workflows/run") {
    // Run the workflow NOW — hand it to the Director as an order (full DELEGATE
    // power), and ride the result back.
    readBody(req, (body) => {
      try {
        const w = JSON.parse(body || "{}");
        queueDirectorTurn((release) => {
          ceoFlow(
            "Execute this workflow now. Do each step in order. When a node has SEVERAL " +
              "OUTGOING arrows, those branches run in PARALLEL — and you must REALLY run " +
              "them in parallel by ending your reply with one `SUB: <branch task>` line per " +
              "branch (they become real ghost clones the owner can watch split off). Do NOT " +
              "just say you split — emit the SUB: lines. A node with several incoming arrows " +
              "waits for all branches, then continues from their merged results. Report the " +
              "final result.\n\n" +
              workflowToText(w),
            undefined,
            undefined,
            {
              logPrompt: "🔀▶ workflow を実行: " + (w.name || ""),
              onDone: (out, ok) => {
                release();
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({
                    ok: !!ok,
                    result:
                      ok && out
                        ? out
                        : "実行に失敗しました。もう一度お試しください",
                  }),
                );
              },
            },
          );
        });
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/workflows/skill") {
    // Compile the workflow into a reusable SKILL — then it can be assigned to an
    // agent (Settings → agent → tick the skill) and triggered on demand.
    readBody(req, (body) => {
      try {
        const w = JSON.parse(body || "{}");
        const nm = String(w.name || "Workflow").slice(0, 50);
        const id = ("wf-" + slugId(nm)).slice(0, 50);
        reg.skills[id] = {
          name: ("🔀 " + nm).slice(0, 60),
          description: ("Run the saved workflow: " + nm).slice(0, 200),
          content: (
            'When asked to run "' +
            nm +
            '", follow this workflow exactly:\n\n' +
            workflowToText(w) +
            "\nDo the steps in order. For a node with several OUTGOING arrows, REALLY run " +
            "the branches in parallel by ending the reply with one `SUB: <branch task>` line " +
            "per branch (they become real ghost clones) — don't just describe splitting. At " +
            "a node with several incoming arrows, wait for all branches then continue from " +
            "their merged results. Report the final result clearly."
          ).slice(0, 4000),
        };
        saveReg();
        try {
          if (retrievalOk) {
            retrieval.reindexSkill(id, reg.skills[id]);
            retrieval.persist();
          }
        } catch {}
        pushRoster();
        broadcast({
          type: "skill.created",
          agent: "",
          skill: reg.skills[id].name,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, name: reg.skills[id].name }));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/event") {
    readBody(req, (body) => {
      try {
        const evt = JSON.parse(body);
        // Hook events from the host Claude Code session arrive as "claude" —
        // that IS the Director: map them onto main (no ghost duplicate).
        if (evt.agent === "claude") evt.agent = "main";
        // Transient UI state (visibility, monitor count) must never replay.
        broadcast(
          evt,
          !["ui.visibility", "ui.monitors", "ui.monitor"].includes(evt.type),
        );
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
  } else if (req.method === "POST" && req.url === "/perm/request") {
    // PreToolUse hook long-polls here; we answer when the user decides.
    readBody(req, (body) => {
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        res.writeHead(400);
        return res.end();
      }
      let { id, agent = "claude", task = "", tool = "?", input = "" } = p;
      if (agent === "claude") agent = "main"; // host session = the Director
      // Tools the owner GRANTED in the agent's registry profile never ask —
      // that's what granting means. "Allow ตลอดไป" rules ride along too.
      const base = String(agent).split("#")[0];
      const granted = [
        ...((reg.agents[base] || {}).tools || []),
        ...((reg.autoAllow || {})[base] || []),
      ];
      const isGranted =
        granted.includes(tool) ||
        // MCP grants are stored as "mcp:<server>"; hook tool names arrive
        // as "mcp__<server>__<tool>".
        granted.some(
          (g) =>
            g.startsWith("mcp:") &&
            String(tool).startsWith("mcp__" + g.slice(4) + "__"),
        );
      if (isGranted) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ decision: "allow" }));
        broadcast({
          type: "perm.approved",
          agent,
          task,
          tool,
          perm: id,
          via: "rule",
        });
        return;
      }
      broadcast({ type: "perm.requested", agent, task, tool, perm: id, input });
      const timer = setTimeout(() => {
        // No human around — deny safely and let the agent re-plan.
        finishPerm(id, "deny", "timeout");
      }, 50000);
      pendingPerms.set(id, { res, timer, agent, task, tool });
    });
  } else if (req.method === "POST" && req.url === "/perm/respond") {
    readBody(req, (body) => {
      try {
        const { id, decision, always } = JSON.parse(body);
        // "Allow ตลอดไป": remember the grant — broker auto-approves future
        // requests AND the tool joins the agent's allowlist for new runs.
        if (always && decision === "allow") {
          const pend = pendingPerms.get(id);
          if (pend) {
            const base = String(pend.agent).split("#")[0];
            reg.autoAllow = reg.autoAllow || {};
            reg.autoAllow[base] = [
              ...new Set([...(reg.autoAllow[base] || []), pend.tool]),
            ];
            const a = reg.agents[base];
            if (a && Array.isArray(a.tools) && !a.tools.includes(pend.tool))
              a.tools.push(pend.tool);
            saveReg();
            pushRoster();
          }
        }
        const ok = finishPerm(
          id,
          decision === "allow" ? "allow" : "deny",
          "user",
        );
        res.writeHead(ok ? 200 : 404);
        res.end(ok ? "ok" : "unknown id");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
  } else if (req.method === "POST" && req.url === "/gen/image") {
    // 🖼 system tool: prompt → PNG path (+ /uploads url for chat rendering).
    readBody(req, (body) => {
      try {
        const { prompt } = JSON.parse(body);
        if (!prompt) throw new Error("no prompt");
        genImage(prompt)
          .then((out) => {
            broadcast({ type: "image.generated", url: out.url }, false);
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
            });
            res.end(JSON.stringify(out));
          })
          .catch((e) => {
            res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
            res.end(String(e.message));
          });
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url === "/proposals") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ proposals: proposals.slice(-30).reverse() }));
  } else if (req.method === "POST" && req.url === "/proposals/dismiss") {
    // 🧹 Quietly clear pending proposals off the owner's plate — bulk or all.
    // Unlike "reject", this sends NO message to the team and makes no noise in
    // the feed; it just marks them dismissed so they drop out of the list.
    readBody(req, (body) => {
      try {
        if (!req.headers["x-bagidea-ui"]) {
          res.writeHead(403);
          return res.end("human UI only");
        }
        const p = JSON.parse(body || "{}");
        const ids = p.all ? null : new Set(p.ids || []);
        let n = 0;
        for (const pr of proposals) {
          if (pr.status !== "pending") continue;
          if (ids && !ids.has(pr.id)) continue;
          pr.status = "dismissed";
          n++;
        }
        if (n) saveProposals();
        broadcast({ type: "proposals.dismissed", count: n }, false);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, dismissed: n }));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/proposals/respond") {
    // CEO verdict on a team pitch: approve → a real project is born in the
    // playground and the Director staffs it; reject/hold are remembered.
    readBody(req, (body) => {
      try {
        if (!req.headers["x-bagidea-ui"]) {
          res.writeHead(403);
          return res.end("human UI only");
        }
        const { id, decision, message } = JSON.parse(body);
        const p = proposals.find((x) => x.id === id);
        if (!p) {
          res.writeHead(404);
          return res.end("unknown proposal");
        }
        p.status =
          decision === "approve"
            ? "approved"
            : decision === "reject"
              ? "rejected"
              : "pending";
        const note = String(message || "")
          .slice(0, 600)
          .trim(); // owner's optional note
        if (note) p.message = note;
        saveProposals();
        const noteLine = note ? `オーナーからのメッセージ： "${note}"\n` : "";
        if (decision === "approve") {
          let proj = null;
          // Approved projects are born in a DEFAULT projects folder (the
          // playground) when no location was given — agents never scaffold loose.
          const playDir = String(
            reg.playground || path.join(WORKSPACE, "projects"),
          );
          try {
            proj = createProject(
              p.name,
              "",
              path.join(playDir, p.name.replace(/[^\wก-๙ -]/g, "_")),
            );
          } catch (e) {
            /* duplicate name → Director routes to the existing one */
          }
          queueDirectorTurn((release) => {
            runClaude(
              "main",
              `CEO がチームのプロジェクト提案を承認しました 🎉\n` +
                `名称：${p.name}\nアイデア：${p.detail}\n提案者：${p.agents.join(", ")}\n` +
                noteLine +
                (proj
                  ? `プロジェクトはすでに ${proj.dir} に作成済みです（このフォルダ内でのみ作業すること）\n`
                  : "") +
                `ルール：プログラムのコアシステム（daemon/godot/shell/cli）を絶対に変更しないこと — ` +
                `オフィスの拡張なら、docs/guide/plugins.md に従って plugin として作ること ` +
                `（template から始める：github.com/bagidea/bagidea-office-template）。\n` +
                `すぐチームを編成しよう：DELEGATE: <agent> @ ${p.name} :: <明確な最初の一件> ` +
                `アイデアを提案した人を中心に担当させ、短く計画をまとめてください` +
                (note
                  ? ` そしてオーナーのメッセージも取り入れて作業の方向を調整してください`
                  : ""),
              {
                logPrompt: `✅ 提案を承認: ${p.name}`,
                filterText: makeDelegateFilter(0, undefined),
                onDone: () => release(),
              },
            );
          });
        } else if (decision === "reject" && note) {
          // The team hears WHY — the owner's note lands in the office feed.
          broadcast({
            type: "chat.message",
            agent: "main",
            text: `CEO はまだ "${p.name}" を承認していません — ${note}`,
          });
        }
        broadcast({
          type: "proposal." + p.status,
          agent: p.by,
          name: p.name,
          proposal: p.id,
        });
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url.split("?")[0] === "/i18n/all") {
    // The whole cached map for a language (seed + anything translated since).
    // The overlay pulls this once on load so tr() knows every seeded string up
    // front — no first-switch Thai flash, and strings in NO_I18N subtrees (the
    // now-strip chrome) can be translated inline too.
    const L = String(
      (req.url.split("?")[1] || "").replace(/^lang=/, ""),
    ).toLowerCase();
    let map = {};
    if (L && L !== "th" && /^[a-z]{2}$/.test(L)) {
      try {
        map = JSON.parse(
          fs.readFileSync(path.join(__dirname, "i18n", L + ".json"), "utf8"),
        );
      } catch {}
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ map }));
  } else if (req.method === "POST" && req.url === "/i18n") {
    // 🌐 auto-translate UI strings to any language via Gemini, cached to
    // disk (daemon/i18n/<lang>.json) so it's instant + shared next time.
    // The overlay sends the Thai strings it finds on screen; we return the
    // full map for those, translating only the ones not yet cached.
    readBody(req, (body) => {
      try {
        const { lang, strings } = JSON.parse(body);
        const L = String(lang || "").toLowerCase();
        if (!L || L === "th" || !Array.isArray(strings)) {
          res.writeHead(400);
          return res.end("bad");
        }
        const dir = path.join(__dirname, "i18n");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, L + ".json");
        let cache = {};
        try {
          cache = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {}
        const want = [
          ...new Set(
            strings.map((s) => String(s)).filter((s) => s && s.length <= 400),
          ),
        ];
        const missing = want.filter((s) => !(s in cache));
        const reply = () => {
          const out = {};
          for (const s of want) if (cache[s] !== undefined) out[s] = cache[s];
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ map: out }));
        };
        // Reply with whatever's cached RIGHT NOW — never make the overlay wait
        // on a slow Gemini call for a handful of uncached strings. That used to
        // block the WHOLE batch, so switching language flashed Thai for seconds
        // even when ~everything was already seeded. The misses translate in the
        // background (cached to disk); the overlay's ~1.5s janitor sweep re-asks
        // and picks them up the moment they're ready.
        reply();
        const gm = (reg.apiKeys || {}).GEMINI_API_KEY;
        if (!missing.length || !gm) return;
        const langName =
          {
            en: "English",
            zh: "Simplified Chinese",
            ja: "Japanese",
            ko: "Korean",
            es: "Spanish",
            fr: "French",
            de: "German",
            hi: "Hindi",
            ar: "Arabic",
            pt: "Portuguese",
            ru: "Russian",
            id: "Indonesian",
            vi: "Vietnamese",
          }[L] || L;
        // batch in chunks to keep prompts sane
        const chunks = [];
        for (let i = 0; i < missing.length; i += 60)
          chunks.push(missing.slice(i, i + 60));
        let pending = chunks.length;
        const finish = () => {
          if (--pending <= 0) {
            try {
              const tmp = file + ".tmp";
              fs.writeFileSync(tmp, JSON.stringify(cache));
              fs.renameSync(tmp, file);
            } catch {}
          }
        };
        for (const chunk of chunks) {
          const prompt =
            `Translate these UI strings from Thai to ${langName}. ` +
            `Keep emoji, symbols, numbers, code and placeholders (like \${...}, <...>) EXACTLY. ` +
            `Natural, concise product-UI wording. Return ONLY a JSON object mapping each ` +
            `original string to its translation.\n\n` +
            JSON.stringify(chunk);
          const reqBody = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.2,
            },
          });
          const rq = require("https").request(
            {
              method: "POST",
              host: "generativelanguage.googleapis.com",
              path:
                "/v1beta/models/gemini-flash-latest:generateContent?key=" + gm,
              headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(reqBody),
              },
            },
            (rs) => {
              rs.setEncoding("utf8"); // multibyte-safe (translations) across chunk boundaries
              let o = "";
              rs.on("data", (c) => (o += c));
              rs.on("end", () => {
                try {
                  const j = JSON.parse(o);
                  const txt =
                    j.candidates &&
                    j.candidates[0] &&
                    j.candidates[0].content.parts
                      .map((p) => p.text || "")
                      .join("");
                  const m = JSON.parse(txt.match(/\{[\s\S]*\}/)[0]);
                  for (const k of chunk)
                    if (m[k] !== undefined) cache[k] = String(m[k]);
                  auxCost(
                    "gemini",
                    chunk.join("").length * COST_RATES.gemini_i18n_per_char,
                  );
                } catch (e) {
                  console.error("[i18n]", e.message);
                }
                finish();
              });
            },
          );
          rq.setTimeout(40000, () => {
            rq.destroy();
            finish();
          });
          rq.on("error", () => finish());
          rq.write(reqBody);
          rq.end();
        }
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/registry/lang") {
    readBody(req, (body) => {
      try {
        reg.lang = String(JSON.parse(body).lang || "en")
          .slice(0, 5)
          .toLowerCase();
        saveReg();
        pushRoster();
        // Tell the wallpaper world to re-pull its status-plate translations so
        // the 3D office matches the overlay's language live (transient — not
        // journaled; godot also reads the language on its own startup).
        broadcast({ type: "ui.lang", lang: reg.lang }, false);
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
  } else if (req.method === "POST" && req.url === "/registry/social") {
    readBody(req, (body) => {
      try {
        reg.socialMin = Math.max(0, Number(JSON.parse(body).min) || 0);
        saveReg();
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
  } else if (req.method === "POST" && req.url === "/registry/proposalmin") {
    readBody(req, (body) => {
      try {
        reg.proposalMin = Math.max(0, Number(JSON.parse(body).min) || 0);
        saveReg();
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
  } else if (req.method === "POST" && req.url === "/registry/fallback") {
    // OPT-IN office-wide emergency fallback brain: which backend a sustainedly-overloaded
    // agent is re-run on. Empty / "none" clears it (feature off). Only a known builtin or a
    // configured custom provider is accepted — so a typo can't silently disable failover.
    readBody(req, (body) => {
      try {
        const b = JSON.parse(body);
        const p = String(b.provider || "").trim();
        if (!p || p === "none") {
          reg.fallbackProvider = "";
          reg.fallbackModel = "";
        } else {
          if (!providers.PROVIDERS[p] && !(reg.providerConfig || {})[p])
            throw new Error("unknown provider");
          reg.fallbackProvider = p;
          reg.fallbackModel = String(b.model || "").slice(0, 60);
        }
        saveReg();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "GET" && req.url === "/tts/presets") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(VOICE_PRESETS).map(([id, p]) => [id, p.label]),
        ),
      ),
    );
  } else if (req.method === "POST" && req.url === "/tts") {
    // 🗣 speak: {text, preset} or {text, agent} (uses the agent's voice).
    // {intro:true} → a gender- + language-aware self-introduction (voice preview).
    readBody(req, (body) => {
      try {
        const { text, preset, agent, intro } = JSON.parse(body);
        const pid = preset || (reg.agents[agent] && reg.agents[agent].voice);
        if (!pid) throw new Error("この agent はまだ音声が設定されていません");
        const say = intro ? voiceIntro(pid, reg.lang || "en") : text;
        if (!say) throw new Error("no text");
        ttsSpeak(pid, say)
          .then((wav) => {
            res.writeHead(200, {
              "content-type": "audio/wav",
              "cache-control": "no-store",
            });
            res.end(wav);
          })
          .catch((e) => {
            res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
            res.end(String(e.message));
          });
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });
  } else if (req.method === "POST" && req.url === "/registry/tts") {
    readBody(req, (body) => {
      try {
        reg.tts = !!JSON.parse(body).enabled;
        saveReg();
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
  } else if (req.method === "POST" && req.url === "/registry/ambient") {
    readBody(req, (body) => {
      try {
        reg.ambient = !!JSON.parse(body).enabled;
        saveReg();
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
  } else if (req.method === "POST" && req.url === "/voice/transcribe") {
    // 🎤 WAV in → text out (Whisper / Gemini via the key vault).
    readBodyRaw(req, (buf) => {
      if (!buf || buf.length < 4000) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        return res.end(
          "音声が短すぎます — 押し続けて話し終えてから離してください",
        );
      }
      if (buf.length > 24 * 1024 * 1024) {
        res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
        return res.end("クリップが長すぎます（上限 約60秒）");
      }
      voiceTranscribe(buf)
        .then((text) => {
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ text }));
        })
        .catch((e) => {
          console.error("[voice]", e.message);
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(String(e.message || e));
        });
    });
  } else if (req.method === "POST" && req.url === "/update") {
    // Human-triggered only (in-app 🔄 button or the CLI).
    if (!req.headers["x-bagidea-ui"]) {
      res.writeHead(403);
      return res.end("human UI only");
    }
    if (process.platform === "win32") {
      const ps = path.join(__dirname, "..", "installer", "update.ps1");
      // Launch in a REAL, visible console window via `cmd start` so the user can
      // watch git pull + the rebuild — a silent detached process looked hung. It
      // also outlives this daemon (the updater kills + relaunches the whole suite).
      spawn(
        "cmd.exe",
        [
          "/c",
          "start",
          "BagIdea Update",
          "powershell",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          ps,
        ],
        { detached: true, stdio: "ignore", windowsHide: false },
      ).unref();
    } else if (process.platform === "darwin") {
      // macOS: git pull + rebuild in a visible Terminal window
      const root = path.join(__dirname, "..");
      const script = `tell application "Terminal" to do script "cd '${root}' && git pull && ./build-mac.sh"`;
      spawn("osascript", ["-e", script], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      // Linux: same idea, x-terminal-emulator
      const root = path.join(__dirname, "..");
      spawn(
        "x-terminal-emulator",
        ["-e", `cd '${root}' && git pull && bash build-mac.sh`],
        { detached: true, stdio: "ignore" },
      ).unref();
    }
    res.writeHead(200);
    res.end("ok");
  } else if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        clients: wsClients.size,
        pendingPerms: pendingPerms.size,
        wt: HAS_WT,
      }),
    );
  } else if (req.url === "/platform") {
    // Single source of truth for the client: which OS is the daemon on,
    // and which path separator to use. Avoids deprecated navigator.platform.
    // nativePick is a hint: macOS/Windows always have a native picker; Linux
    // does only when zenity is on PATH. The client still treats a 404 from
    // /fs/native-pick as the authoritative "fall back to in-house" signal,
    // so this field is informational, not a guarantee.
    const nativePick =
      process.platform === "win32" || process.platform === "darwin"
        ? true
        : wslx.isWSL() || canZenity(); // hybrid uses the Windows picker via interop
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        platform: process.platform,
        sep: path.sep,
        nativePick,
      }),
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

function finishPerm(id, decision, why) {
  const p = pendingPerms.get(id);
  if (!p) return false;
  pendingPerms.delete(id);
  clearTimeout(p.timer);
  p.res.writeHead(200, { "content-type": "application/json" });
  p.res.end(JSON.stringify({ decision }));
  broadcast({
    type: decision === "allow" ? "perm.approved" : "perm.denied",
    agent: p.agent,
    task: p.task,
    tool: p.tool,
    perm: id,
    via: why,
  });
  return true;
}

// WS upgrade — renderers (Godot) and overlays share one stream.
// Parse masked client→server WS frames (the event stream never needed this;
// the realtime voice bridge does). Calls cb(opcode, payloadBuffer).
function makeFrameParser(cb) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      const masked = !!(buf[1] & 0x80);
      let len = buf[1] & 0x7f,
        off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload;
      if (masked) {
        const mask = buf.slice(off, off + 4);
        payload = Buffer.from(buf.slice(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      } else payload = buf.slice(off, off + len);
      buf = buf.slice(need);
      cb(op, payload);
    }
  };
}

// Drop a record of a voice call into main's latest thread (chat-app style: who + when +
// how long), so the owner sees the call in the conversation history.
function logCall(text) {
  try {
    const list = sess["main"] || [];
    const entry = list.length
      ? list.reduce((x, y) => (x.ts > y.ts ? x : y))
      : null;
    if (entry) {
      entry.log.push({ who: "agent", text, ts: Date.now() });
      while (entry.log.length > 200) entry.log.shift();
      saveSess();
    }
    broadcast({
      type: "chat.message",
      agent: "main",
      text,
      session: entry && entry.key,
    });
  } catch {}
}

// 📞 Realtime voice: bridge the overlay mic ⇄ Gemini Live, with the office's
// own knowledge in the system prompt and an agent's voice preset.
function handleLive(req, sock) {
  const key = req.headers["sec-websocket-key"];
  if (!key) return sock.destroy();
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
      "Connection: Upgrade\r\nSec-WebSocket-Accept: " +
      wsAccept(key) +
      "\r\n\r\n",
  );
  const toClient = (obj) => {
    try {
      sock.write(wsFrame(JSON.stringify(obj)));
    } catch {}
  };
  const gm = (reg.apiKeys || {}).GEMINI_API_KEY;
  if (!gm) {
    toClient({
      type: "error",
      text: "realtime には GEMINI_API_KEY（⚙ CONNECT）が必要です",
    });
    return;
  }

  // Calling is for the MAIN agent only — it speaks for the whole office. Use the
  // voice the owner assigned to main; if none, fall back to a default preset.
  const a = reg.agents["main"] || {};
  const presetVoice = (VOICE_PRESETS[a.voice] || {}).voice || "Aoede";
  const ctxNote = (() => {
    try {
      return fs.readFileSync(OFFICE_MD, "utf8").slice(0, 2000);
    } catch {
      return "";
    }
  })();
  const team = teamList();
  // A live office snapshot so the call agent actually knows its work (projects running,
  // proposals waiting, scheduled jobs) — not just the team roster.
  const snap = (() => {
    const out = [];
    try {
      const ps = projectStatus();
      if (ps.length)
        out.push(
          "Projects: " +
            ps.map((p) => p.name + (p.ai ? " (in progress)" : "")).join(", "),
        );
    } catch {}
    try {
      const pend = (proposals || []).filter((p) => p.status === "pending");
      if (pend.length)
        out.push(
          "Proposals awaiting the owner's approval: " +
            pend.map((p) => p.name).join(", "),
        );
    } catch {}
    try {
      const jb = (jobs || []).filter((j) => !j.done && j.enabled !== false);
      if (jb.length) out.push("Scheduled jobs: " + jb.length);
    } catch {}
    return out.join("\n");
  })();
  let callStart = 0,
    callStartStr = "",
    callEnded = false;
  const endCall = () => {
    if (callEnded || !callStart) return;
    callEnded = true;
    const s = Math.round((Date.now() - callStart) / 1000);
    const dur = s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
    logCall(
      `📞 ${a.name || "アシスタント"} と音声通話 · ${callStartStr} · 通話時間 ${dur}`,
    );
  };

  const gemini = require("./channels").wsConnect(
    "generativelanguage.googleapis.com",
    "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" +
      gm,
    {
      onOpen() {
        gemini.send(
          JSON.stringify({
            setup: {
              model: "models/gemini-2.5-flash-native-audio-latest",
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: presetVoice },
                  },
                },
              },
              systemInstruction: {
                parts: [
                  {
                    text:
                      `あなたは BagIdea Office のチームリーダー（Director）"${a.name || "アシスタント"}" — オーナー（CEO）の右腕です。` +
                      `いまオーナーとライブ音声通話をしています。親しみやすく、簡潔に、自然に話してください（日本語。ただしオーナーが英語で話す場合を除く）。` +
                      `あなたは自分の業務とオフィスをよく知っています — チーム、プロジェクト、業務の状況について答え、思考/計画を存分に手伝えます。` +
                      `オーナーが新しい業務を指示したら、いったん引き受け、通話を切った後に対応/チームに割り当てると伝えてください ` +
                      `（通話中はまだ実作業やツールの呼び出しはできません）。\n\n` +
                      (voiceGender(a.voice) === "m"
                        ? `あなたの性別：男性 — 常に男性として話し、自分を呼ぶこと（男性的な一人称・話し方を使う）。あなたの声に合わせ、女性のような話し方はしないこと。\n\n`
                        : `あなたの性別：女性 — 常に女性として話し、自分を呼ぶこと（女性的な一人称・話し方を使う）。あなたの声に合わせ、男性のような話し方はしないこと。\n\n`) +
                      `チーム：\n${team}\n\n今のオフィスの状況：\n${snap || "(まだプロジェクト/残業務はありません)"}\n\nオフィスの記録：\n${ctxNote}`,
                  },
                ],
              },
            },
          }),
        );
        toClient({ type: "ready" });
      },
      onMsg(raw) {
        let m;
        try {
          m = JSON.parse(raw);
        } catch {
          return;
        }
        if (m.setupComplete) {
          callStart = Date.now();
          const d = new Date();
          callStartStr =
            ("0" + d.getHours()).slice(-2) +
            ":" +
            ("0" + d.getMinutes()).slice(-2);
          return toClient({ type: "live-ready" });
        }
        const parts =
          m.serverContent &&
          m.serverContent.modelTurn &&
          m.serverContent.modelTurn.parts;
        if (parts)
          for (const p of parts) {
            if (p.inlineData && p.inlineData.data)
              toClient({ type: "audio", data: p.inlineData.data }); // 24k PCM base64
          }
        if (m.serverContent && m.serverContent.turnComplete)
          toClient({ type: "turn-done" });
      },
      onClose() {
        endCall();
        toClient({ type: "closed" });
        try {
          sock.end();
        } catch {}
      },
    },
  );

  // overlay → us: text frames carry {type:'audio', data} (16k PCM base64).
  const parse = makeFrameParser((op, payload) => {
    if (op === 8) {
      try {
        gemini.close();
      } catch {}
      return;
    }
    if (op !== 1) return;
    let m;
    try {
      m = JSON.parse(payload.toString("utf8"));
    } catch {
      return;
    }
    if (m.type === "audio") {
      gemini.send(
        JSON.stringify({
          realtimeInput: {
            mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: m.data }],
          },
        }),
      );
    }
  });
  sock.on("data", parse);
  sock.on("close", () => {
    endCall();
    try {
      gemini.close();
    } catch {}
  });
  sock.on("error", () => {
    endCall();
    try {
      gemini.close();
    } catch {}
  });
}

server.on("upgrade", (req, sock) => {
  if (req.url.startsWith("/live")) return handleLive(req, sock);
  if (!req.url.startsWith("/ws")) return sock.destroy();
  const key = req.headers["sec-websocket-key"];
  if (!key) return sock.destroy();
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
  );
  wsClients.add(sock);
  console.log("[oep] ws client connected", `(${wsClients.size})`);
  sock.on("close", () => wsClients.delete(sock));
  sock.on("error", () => wsClients.delete(sock));
  sock.on("data", () => {}); // inbound frames (pings/close) — TCP close is enough
  // Journal replay so a restarted renderer/overlay rebuilds its state.
  for (const line of journalTail(REPLAY_COUNT)) {
    try {
      const evt = JSON.parse(line);
      evt.replay = true;
      sock.write(wsFrame(JSON.stringify(evt)));
    } catch {}
  }
  // Fresh roster snapshot last — registry.json is the truth, not the journal.
  sock.write(wsFrame(JSON.stringify({ ...rosterEvt(), ts: Date.now() })));
});

// Resilience: the office is an always-on daemon spawned by a console-less GUI
// shell, so a single stray exception (a bad scheduler tick, a malformed plugin
// event) must NOT take the whole office down. Log it and keep serving — the
// shell's watchdog can still restart us if we ever truly die.
process.on("uncaughtException", (e) =>
  console.error("[fatal] uncaught:", (e && e.stack) || e),
);
process.on("unhandledRejection", (e) =>
  console.error("[fatal] rejection:", (e && e.stack) || e),
);

// Issue #15 (Bug 3): on restart/quit, SIGKILL every spawned claude child so
// none get reparented to PID 1 and keep making proxy requests after the daemon
// that owns them is gone. The new daemon boots with an empty runChildren map,
// so anything we leave alive is untraceable.
let _shuttingDown = false;
function gracefulShutdown(sig) {
  if (_shuttingDown) return; // second Ctrl-C → fall through to default die
  _shuttingDown = true;
  let n = 0;
  for (const { child } of runChildren.values()) {
    killTree(child);
    n++;
  }
  console.error(`[daemon] ${sig} — killed ${n} child process(es)`);
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

server.on("error", (e) => {
  // Most likely EADDRINUSE — another daemon already holds :8787. Exit cleanly
  // (code 1) so the launcher/watchdog knows not to expect us, instead of a
  // cryptic unhandled-error crash.
  console.error("[fatal] server error:", (e && e.message) || e);
  process.exit(1);
});

const OEP_PORT = process.env.OEP_PORT || 8787; // override only for isolated tests
// Issue #15 (Bug 4): rewrite {workspace}/.claude/settings.json so the
// PreToolUse hook resolves to THIS install's perm.js — works on macOS, Linux,
// and Windows without a committed absolute path, and runs even when the user
// skips the installer's wire-hooks script (clone-and-run dev workflow).
try {
  wireWorkspaceSettings(WORKSPACE, __dirname);
} catch (e) {
  console.error("[startup] wireWorkspaceSettings failed:", e && e.message);
}
server.listen(OEP_PORT, "127.0.0.1", () => {
  console.log(`[oep] http+ws listening :${OEP_PORT}`);
  // Fresh boot ⇒ nothing is running (runChildren starts empty). A task.started left
  // dangling in the journal by the previous (killed) run would otherwise REPLAY on the
  // next client connect and pin agents as "working" forever. Journal a reset so it
  // replays last and clears any stale working state on the wallpaper + overlay.
  broadcast({ type: "task.reset" });
});

// Parent-death watchdog: if the shell that spawned us (via OEP_SPAWNED=1) exits
// or crashes, we self-shutdown instead of going orphan on PID 1 and holding port
// 8787 forever. Polls every 3s — cheap, and 3s is fast enough to avoid port
// collisions on a quick restart. Only active when OEP_SPAWNED is set, so a
// manual `node server.js` from a terminal won't false-positive.
if (process.env.OEP_SPAWNED === "1") {
  const parentPid = process.ppid;
  setInterval(() => {
    try {
      // process.kill(pid, 0) throws if the process no longer exists.
      process.kill(parentPid, 0);
    } catch {
      console.log("[oep] parent shell exited — shutting down daemon.");
      for (const child of runChildren.values()) {
        try {
          child.kill("SIGTERM");
        } catch {}
      }
      server.close();
      process.exit(0);
    }
  }, 3000);
}
