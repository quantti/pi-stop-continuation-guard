import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import extension from "../extensions/stop-continuation-guard.ts";

function responseFor(packet, overrides = {}) {
  return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({
    decision: "continue", authorizingInputIds: packet.operatorInputs.map(i => i.id),
    finalEntryId: packet.final.id, remainingWork: "Synchronize the two versions",
    reason: "The requested synchronization is unfinished", independentWork: false, ...overrides,
  }) }] };
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
    modelRegistry: {
      find: () => ({ provider: "openai-codex", id: "gpt-6-luna", api: "openai-codex-responses" }),
      complete: async (model, context, options) => {
        const packet = JSON.parse(context.messages[0].content);
        calls.push({ model, context, options, packet });
        return answer ? await answer(packet, options) : responseFor(packet);
      },
    },
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
  assert.equal(h.calls[0].model.id, "gpt-6-luna");
  assert.deepEqual(h.calls[0].context.tools, []);
  assert.equal(h.calls[0].options.reasoningEffort, "low");
  assert.equal(h.calls[0].options.maxRetries, 0, "do not inherit provider retries for the judge");
  assert.equal(h.calls[0].packet.operatorInputs[0].text, "Document ownership and synchronize both versions. Do not push.");
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
    () => ({ stopReason: "stop", content: [{ type: "text", text: "not JSON" }] }),
    packet => responseFor(packet, { decision: "approve" }),
    packet => responseFor(packet, { finalEntryId: "other-answer" }),
    packet => responseFor(packet, { authorizingInputIds: [] }),
    packet => responseFor(packet, { authorizingInputIds: ["invented"] }),
    packet => responseFor(packet, { extra: "unrecognized" }),
    packet => responseFor(packet, { remainingWork: "x".repeat(301) }),
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
  t.mock.timers.tick(20_001);
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

test("missing scope and bounded context limits do not grant authority", async () => {
  for (const scenario of ["old-history", "long-input", "too-many-inputs", "attachment", "long-answer", "model-scope"]) {
    const h = host();
    if (scenario === "old-history") h.input("Injected task", "extension");
    else if (scenario === "long-input") h.input("x".repeat(2001));
    else if (scenario === "too-many-inputs") for (let i = 0; i < 7; i++) h.input(`Restriction ${i}`);
    else if (scenario === "attachment") h.emit("input", { source: "interactive", text: "Do what the picture says", images: [{}] });
    else h.input("Synchronize both versions.");
    if (scenario === "model-scope") h.ctx.scopedModels = [{ model: { provider: "other", id: "other" } }];
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
  assert.equal(h.calls[0].packet.backgroundWorkPending, true);
  h.setAnswer(packet => responseFor(packet, { independentWork: true }));
  assert.equal((await h.judge(h.finish())).continue, true);
  h.bus.emit("subagent:async-complete", { sessionId: "fixture-session", runId: "job-1" });
  let resolve;
  h.setAnswer(() => new Promise(done => { resolve = done; }));
  const pending = h.judge(h.finish());
  h.bus.emit("subagent:async-started", { sessionId: "fixture-session", id: "job-2" });
  resolve(responseFor(h.calls.at(-1).packet, { independentWork: true }));
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
    assert.equal(h.calls[0].packet.backgroundWorkPending, true);
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
    const judge = fauxProvider({ provider: "openai-codex", models: [{ id: "gpt-6-luna" }] });
    runtime.registerNativeProvider(main.provider);
    runtime.registerNativeProvider(judge.provider);
    let judgments = 0;
    runtime.complete = async (model, context) => {
      assert.equal(model.id, "gpt-6-luna");
      assert.deepEqual(context.tools, []);
      const packet = JSON.parse(context.messages[0].content);
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
    runtime.complete = async (_model, _context, options) => {
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
