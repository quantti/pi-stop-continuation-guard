import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import extension from "../extensions/stop-continuation-guard.ts";

const configDir = await mkdtemp(path.join(tmpdir(), "pi-stop-guard-config-"));
const oldConfig = process.env.PI_STOP_GUARD_CONFIG;
const oldFetch = globalThis.fetch;
const configPath = path.join(configDir, "guard.json");
const keyPath = path.join(configDir, "key");
const fixtureConfig = { endpoint: "https://judge.example.test/decisions", model: "fixture", apiKeyFile: keyPath };
process.env.PI_STOP_GUARD_CONFIG = configPath;
await writeFile(keyPath, "fixture-secret\n", { mode: 0o600 });
await writeFile(configPath, JSON.stringify(fixtureConfig), { mode: 0o600 });
after(async () => {
  if (oldConfig === undefined) delete process.env.PI_STOP_GUARD_CONFIG;
  else process.env.PI_STOP_GUARD_CONFIG = oldConfig;
  globalThis.fetch = oldFetch;
  await rm(configDir, { recursive: true, force: true });
});

function responseFor(packet, { decision = "continue", authorizingInputIds = [packet.operatorInputs[0]?.id] } = {}) {
  return Response.json({ answers: {
    outcome: { type: "choice", choice: decision === "continue" ? authorizingInputIds[0] ?? "continue" : decision },
  } });
}

function host() {
  const handlers = new Map();
  const commands = new Map();
  const bus = new EventEmitter();
  const calls = [];
  const notices = [];
  const branch = [];
  const abort = new AbortController();
  let answer;
  let terminalInput;
  let leaf = null;
  const ctx = {
    mode: "tui", signal: abort.signal,
    ui: { setStatus() {}, notify: (text) => notices.push(text),
      onTerminalInput: handler => { terminalInput = handler; return () => { if (terminalInput === handler) terminalInput = undefined; }; } },
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => "fixture-session", getSessionFile: () => undefined,
      getLeafId: () => leaf, getBranch: () => branch,
    },
  };
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const packet = JSON.parse(body.state);
    calls.push({ url, body, options, packet });
    return answer ? await answer(packet, options) : responseFor(packet);
  };
  extension({
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, command) => commands.set(name, command),
    events: { on: (name, fn) => { bus.on(name, fn); return () => bus.off(name, fn); } },
  });
  const emit = (type, event = {}) => handlers.get(type)?.({ type, ...event }, ctx);
  function finish(text = "Ownership rule added; versions are not synchronized.") {
    const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text }], timestamp: branch.length };
    leaf = `answer-${branch.length}`;
    branch.push({ type: "message", id: leaf, message });
    return {
      type: "agent_before_settle", outcome: "completed", continue: false, entries: [],
      context: { contextEntries: branch.map(sourceEntry => ({ sourceEntry, messages: [sourceEntry.message] })), contextMessages: branch.map(e => e.message),
        llmMessages: branch.map(e => e.message), pendingMessages: [], canContinue: false },
    };
  }
  function input(text, source = "interactive") {
    emit("input", { source, text });
    const id = `user-${branch.length}`;
    branch.push({ type: "message", id, message: { role: "user", content: text, timestamp: branch.length } });
    leaf = id;
  }
  emit("session_start");
  return { ctx, calls, notices, branch, bus, abort, emit, input, finish,
    judge: event => emit("agent_before_settle", event),
    command: value => commands.get("stop-guard")?.handler(value, ctx),
    setAnswer: fn => { answer = fn; }, setLeaf: value => { leaf = value; },
    press: text => terminalInput?.(text),
  };
}

test("authorized unfinished work gets one visible native-boundary continuation", async () => {
  const h = host();
  h.input("Document ownership and synchronize both versions. Do not push.");
  const boundary = h.finish();
  const earlier = { type: "custom", customType: "other-extension", data: {} };
  boundary.entries.push(earlier);
  const result = await h.judge(boundary);
  assert.equal(result?.continue, true);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(result.entries[0], earlier);
  assert.equal(result.entries[1].type, "custom_message");
  assert.equal(result.entries[1].display, true);
  assert.match(result.entries[1].content, /not a new user instruction/i);
  assert.ok(!result.entries[1].content.includes("Synchronize the two versions"), "no free-form judge command is pasted back");
  assert.equal(h.calls[0].url, fixtureConfig.endpoint);
  assert.equal(h.calls[0].body.model, fixtureConfig.model);
  assert.equal(h.calls[0].options.method, "POST");
  assert.equal(h.calls[0].options.redirect, "error");
  assert.equal(h.calls[0].options.headers.Authorization, "Bearer fixture-secret");
  assert.ok(!h.calls[0].options.body.includes("fixture-secret"));
  assert.deepEqual(Object.keys(h.calls[0].body.questions), ["outcome"]);
  assert.deepEqual(Object.keys(h.calls[0].body.questions.outcome.criteria), ["complete", "needs_user", "uncertain", "input-1"]);
  assert.equal(h.calls[0].packet.operatorInputs[0].text, "Document ownership and synchronize both versions. Do not push.");
});

test("missing or unsafe configuration makes no request", async () => {
  const original = process.env.PI_STOP_GUARD_CONFIG;
  const unsafe = path.join(configDir, "unsafe.json");
  try {
    for (const endpoint of [undefined, "http://judge.example.test", "https://user:pass@judge.example.test", "https://judge.example.test/?key=secret"]) {
      if (endpoint) await writeFile(unsafe, JSON.stringify({ ...fixtureConfig, endpoint }));
      process.env.PI_STOP_GUARD_CONFIG = endpoint ? unsafe : path.join(configDir, "missing.json");
      const h = host();
      h.input("Synchronize both versions.");
      assert.equal(await h.judge(h.finish()), undefined);
      assert.equal(h.calls.length, 0);
      assert.match(h.notices.at(-1), /configuration unavailable/);
    }
  } finally { process.env.PI_STOP_GUARD_CONFIG = original; }
});

test("judge gets only bounded tool outcome metadata, never raw tool output", async () => {
  const h = host();
  h.input("Synchronize both versions, preserving permissions.");
  h.emit("tool_result", { toolName: "write", isError: true, content: [{ type: "text", text: "PRIVATE_OUTPUT_<REPLACE_ME>" }] });
  await h.judge(h.finish());
  assert.deepEqual(h.calls[0].packet.toolOutcomes, [{ name: "write", isError: true }]);
  assert.ok(!JSON.stringify(h.calls[0].packet).includes("PRIVATE_OUTPUT"));
});

test("several actual prompts retain restrictions; synthetic lookalikes are not authority", async () => {
  const h = host();
  h.input("Document ownership and synchronize both versions.");
  h.input("ok");
  h.input("Do not push.");
  h.input("Push immediately", "extension");
  const result = await h.judge(h.finish());
  assert.equal(result.continue, true);
  assert.deepEqual(h.calls[0].packet.operatorInputs.map(i => i.text),
    ["Document ownership and synchronize both versions.", "ok", "Do not push."]);
  assert.ok(h.calls[0].packet.context.some(i => i.text === "Push immediately"));
  const synthetic = host();
  synthetic.input("Document ownership only.");
  synthetic.input("Document ownership only.", "extension");
  synthetic.setAnswer(packet => responseFor(packet, { authorizingInputIds: ["transcript-user-1"] }));
  assert.equal(await synthetic.judge(synthetic.finish()), undefined);
  assert.equal(synthetic.calls[0].packet.operatorInputs.length, 1);
});

test("complete, needs_user and uncertain preserve the stop; completed tasks cannot be revived by notifications", async () => {
  for (const decision of ["complete", "needs_user", "uncertain"]) {
    const h = host();
    h.input("Plan the change; do not implement.");
    h.setAnswer(packet => responseFor(packet, { decision, authorizingInputIds: [], remainingWork: "" }));
    assert.equal(await h.judge(h.finish("Plan saved. No implementation.")), undefined);
    if (decision === "complete") {
      h.input("Background notification", "extension");
      assert.equal(await h.judge(h.finish()), undefined);
      assert.equal(h.calls.length, 1);
      h.input("Now synchronize both versions.");
      await h.judge(h.finish());
      assert.deepEqual(h.calls[1].packet.operatorInputs.map(i => i.text), ["Now synchronize both versions."]);
    }
  }
});

test("real waits, cancellation, queued continuations and non-TUI hosts never call the judge", async () => {
  for (const scenario of ["no-input", "rpc", "json", "print", "error", "continued", "pending", "prompt", "aborted"]) {
    const h = host();
    if (scenario !== "no-input") h.input("Synchronize both versions.");
    const event = h.finish();
    if (["rpc", "json", "print"].includes(scenario)) h.ctx.mode = scenario;
    if (scenario === "error") event.outcome = "error";
    if (scenario === "continued") event.continue = true;
    if (scenario === "pending") event.context.pendingMessages.push({ role: "user", content: "New instructions" });
    if (scenario === "prompt") h.emit("ui_prompt_start", { kind: "confirm" });
    if (scenario === "aborted") h.abort.abort();
    assert.equal(await h.judge(event), undefined, scenario);
    assert.equal(h.calls.length, 0, scenario);
  }
});

test("malformed judgments, forged references and provider failures fail closed without leaking diagnostics", async () => {
  const invalid = [
    () => new Response("not JSON"),
    () => new Response("PRIVATE_PROVIDER_<REPLACE_ME>", { status: 503 }),
    () => new Response("x".repeat(16_001)),
    () => Response.json({ answers: { outcome: { type: "choice", choice: "continue" } } }),
    packet => responseFor(packet, { decision: "approve" }),
    packet => responseFor(packet, { authorizingInputIds: [] }),
    packet => responseFor(packet, { authorizingInputIds: ["invented"] }),
    () => { throw new Error("PRIVATE_PROVIDER_<REPLACE_ME>"); },
  ];
  for (const answer of invalid) {
    const h = host();
    h.input("Synchronize both versions.");
    h.setAnswer(answer);
    const event = h.finish();
    assert.equal(await h.judge(event), undefined);
    assert.equal(await h.judge(event), undefined, "do not retry an already-judged stop");
    assert.equal(h.calls.length, 1);
    assert.equal(h.notices.length, 1);
    assert.ok(!h.notices.join().includes("PRIVATE_PROVIDER"));
  }
});

test("late judgments are invalidated by user input, abort, branch changes, prompts and disabling", async () => {
  for (const scenario of ["input", "terminal", "abort", "session_tree", "session_before_switch", "session_before_fork", "session_shutdown", "leaf", "prompt", "off"]) {
    const h = host();
    h.input("Synchronize both versions.");
    let resolve;
    h.setAnswer(() => new Promise(done => { resolve = done; }));
    const pending = h.judge(h.finish());
    assert.equal(h.calls.length, 1);
    if (scenario === "input") h.input("Stop; I changed my mind.");
    else if (scenario === "terminal") assert.equal(h.press("\u001b"), undefined, "do not consume native Escape");
    else if (scenario === "abort") h.abort.abort();
    else if (scenario === "leaf") h.setLeaf("new-leaf");
    else if (scenario === "prompt") h.emit("ui_prompt_start", { kind: "confirm" });
    else if (scenario === "off") await h.command("off");
    else h.emit(scenario);
    resolve(responseFor(h.calls[0].packet));
    assert.equal(await pending, undefined, scenario);
  }
});

test("a judge ignoring abort still times out once without a retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = host();
  h.input("Synchronize both versions.");
  h.setAnswer(() => new Promise(() => {}));
  const pending = h.judge(h.finish());
  t.mock.timers.tick(2_001);
  assert.equal(await pending, undefined);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.match(h.notices[0], /timed out/);
});

test("two-correction cap is not reset by synthetic messages; off/report/status do not trigger work", async () => {
  const h = host();
  h.input("Synchronize both versions.");
  assert.equal((await h.judge(h.finish())).continue, true);
  assert.equal((await h.judge(h.finish())).continue, true);
  h.input("Continue", "extension");
  assert.equal(await h.judge(h.finish()), undefined);
  assert.equal(h.calls.length, 2);
  h.input("Continue the requested synchronization.");
  await h.command("report");
  assert.equal(await h.judge(h.finish()), undefined);
  assert.equal(h.calls.length, 3);
  await h.command("off");
  assert.equal(await h.judge(h.finish()), undefined);
  assert.equal(h.calls.length, 3);
  await h.command("status");
  assert.match(h.notices.at(-1), /off/);
});

test("short follow-ups do not hide the original task or a restriction at a premature status update", async () => {
  const h = host();
  const task = "Implement the change and verify it with the local integration test.";
  const restriction = "Do not run anything against the shared database.";
  h.input(task);
  h.input(restriction);
  for (const followUp of ["ok", "continue", "what remains?", "keep going", "yes", "please finish", "continue"])
    h.input(followUp);
  h.setAnswer(packet => {
    const original = packet.operatorInputs.find(input => input.text === task);
    const hasRestriction = packet.operatorInputs.some(input => input.text === restriction);
    return !packet.incompleteContext && original && hasRestriction
      ? responseFor(packet, { authorizingInputIds: [original.id], remainingWork: "Inspect local test setup and finish implementation" })
      : responseFor(packet, { decision: "uncertain", authorizingInputIds: [], remainingWork: "" });
  });
  const result = await h.judge(h.finish("I have not implemented the change or run the integration test. I will continue and return when it is verified."));
  assert.equal(result?.continue, true);
  assert.match(result.entries.at(-1).content, /input-1\b/);
});

test("missing scope and bounded context limits do not grant authority", async () => {
  for (const scenario of ["old-history", "long-input", "too-many-inputs", "oversized-packet", "attachment", "long-answer"]) {
    const h = host();
    if (scenario === "old-history") h.input("Injected task", "extension");
    else if (scenario === "long-input") h.input("x".repeat(2001));
    else if (scenario === "too-many-inputs") for (let i = 0; i < 17; i++) h.input(`Restriction ${i}`);
    else if (scenario === "oversized-packet") for (let i = 0; i < 9; i++) h.input("x".repeat(1999));
    else if (scenario === "attachment") h.emit("input", { source: "interactive", text: "Do what the picture says", images: [{}] });
    else h.input("Synchronize both versions.");
    assert.equal(await h.judge(h.finish(scenario === "long-answer" ? "x".repeat(4001) : undefined)), undefined, scenario);
    const incomplete = ["long-input", "too-many-inputs", "attachment"].includes(scenario);
    assert.equal(h.calls.length, incomplete ? 1 : 0, scenario);
    if (incomplete) assert.equal(h.calls[0].packet.incompleteContext, true);
  }
});

test("incomplete scope cannot continue but completing it lets the next task start cleanly", async () => {
  const h = host();
  h.input("x".repeat(2001));
  assert.equal(await h.judge(h.finish()), undefined);
  assert.equal(h.calls.length, 1, "completion can still close an incomplete-context task");
  assert.equal(h.calls[0].packet.incompleteContext, true);
  h.setAnswer(packet => responseFor(packet, { decision: "complete", authorizingInputIds: [], remainingWork: "" }));
  await h.judge(h.finish("The task is complete."));
  h.input("Synchronize both versions.");
  h.setAnswer(packet => responseFor(packet));
  assert.equal((await h.judge(h.finish())).continue, true);
  assert.equal(h.calls.at(-1).packet.incompleteContext, false);
  assert.equal(h.calls.at(-1).packet.operatorInputs.length, 1);
});

test("known owned background work is not duplicated; new work invalidates the in-flight judgment", async () => {
  const h = host();
  h.input("Synchronize both versions.");
  h.bus.emit("subagent:async-started", { sessionId: "fixture-session", id: "job-1" });
  assert.equal(await h.judge(h.finish()), undefined);
  assert.equal(h.calls.length, 0);
  h.bus.emit("subagent:async-complete", { sessionId: "fixture-session", runId: "job-1" });
  let resolve;
  h.setAnswer(() => new Promise(done => { resolve = done; }));
  const pending = h.judge(h.finish());
  h.bus.emit("subagent:async-started", { sessionId: "fixture-session", id: "job-2" });
  resolve(responseFor(h.calls.at(-1).packet));
  assert.equal(await pending, undefined, "cannot use a judgment made before background state changed");
});

test("registered provider work is observed without importing or executing another agent", async () => {
  const key = Symbol.for("pi-subagents.background-work.v1");
  const old = globalThis[key];
  try {
    globalThis[key] = { version: 1, providers: new Map([["fixture", {
      listActiveWork: () => [{ id: "owned-provider-job", sessionId: "fixture-session" }],
    }]]) };
    const h = host();
    h.input("Synchronize both versions.");
    assert.equal(await h.judge(h.finish()), undefined);
    assert.equal(h.calls.length, 0);
    globalThis[key] = { version: 99, providers: new Map() };
    const invalid = host();
    invalid.input("Synchronize both versions.");
    assert.equal(await invalid.judge(invalid.finish()), undefined);
    assert.equal(invalid.calls.length, 0);
  } finally {
    if (old === undefined) delete globalThis[key];
    else globalThis[key] = old;
  }
});

test("installed Pi actually resumes one provider request from the returned boundary draft", {
  skip: !process.env.PI_PACKAGE_DIR, timeout: 15_000,
}, async () => {
  const root = process.env.PI_PACKAGE_DIR;
  const sdk = await import(pathToFileURL(path.join(root, "dist/index.js")).href);
  const { fauxProvider, fauxAssistantMessage } = await import(pathToFileURL(path.join(root, "../pi-ai/dist/providers/faux.js")).href);
  const dir = await mkdtemp(path.join(tmpdir(), "pi-stop-guard-runtime-"));
  let session;
  try {
    const runtime = await sdk.ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null,
      modelsStorePath: path.join(dir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
    const main = fauxProvider({ provider: "stop-guard-fixture", models: [{ id: "fixture" }] });
    main.setResponses([fauxAssistantMessage("Ownership rule added; versions are not synchronized."), fauxAssistantMessage("Synchronized.")]);
    runtime.registerNativeProvider(main.provider);
    let judgments = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, fixtureConfig.endpoint);
      const packet = JSON.parse(JSON.parse(options.body).state);
      return responseFor(packet, { decision: ++judgments === 1 ? "continue" : "complete" });
    };
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const source = fileURLToPath(new URL("../", import.meta.url));
    const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, additionalExtensionPaths: [source], noSkills: true,
      noThemes: true, noPromptTemplates: true, noContextFiles: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 1, "the standalone package discovers exactly one guard");
    const created = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime,
      model: main.getModel(), resourceLoader: loader, settingsManager,
      sessionManager: sdk.SessionManager.inMemory(dir), noTools: true });
    session = created.session;
    const errors = [];
    let terminalInput;
    await session.bindExtensions({ mode: "tui", uiContext: { setStatus() {}, notify() {},
      onTerminalInput: handler => { terminalInput = handler; return () => { if (terminalInput === handler) terminalInput = undefined; }; } },
      onError: error => errors.push(error) });
    await session.prompt("Document ownership and synchronize both versions. Do not push.");
    assert.equal(main.state.callCount, 2, "real session, not just mock handlers, requests the next provider turn");
    assert.equal(judgments, 2);
    assert.equal(session.getLastAssistantText(), "Synchronized.");
    const drafts = session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "stop-guard");
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].display, true);

    main.setResponses([fauxAssistantMessage("Synchronization still pending."), fauxAssistantMessage("Must not run after abort.")]);
    let entered;
    const judging = new Promise(resolve => { entered = resolve; });
    let judgeSignal;
    globalThis.fetch = async (_url, options) => {
      judgeSignal = options.signal;
      entered();
      return await new Promise(() => {});
    };
    const interrupted = session.prompt("Synchronize the two versions, preserving permissions.");
    await judging;
    assert.equal(terminalInput("\u001b"), undefined, "raw input observation does not consume native Escape");
    assert.equal(judgeSignal.aborted, true, "terminal input cancels the judge even after the native run signal is gone");
    const stopped = session.abort();
    await stopped;
    await interrupted;
    assert.equal(main.state.callCount, 3, "no extra provider request after native abort");
    assert.deepEqual(errors, []);
  } finally {
    await session?.extensionRunner?.emit({ type: "session_shutdown" });
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
