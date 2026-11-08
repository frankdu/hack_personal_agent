import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { conversationSchema, decisionSchema, enabledToolSchema, nodesResponseSchema, PROTOCOL_VERSION, taskResponseSchema, taskSchema, type EnabledTool, type FleetNode, type ModelProfile, type SubmitMessage } from "@agent/contracts";
import { ArrowUp, ArrowUpRight, Check, Cpu, Layers3, MessageSquare, Network, Plus, Radio, RefreshCw, Settings2, ShieldCheck, Sparkles, Square, Terminal, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest, errorText, normalizeBackendUrl, submissionMayHaveSucceeded, type Connection } from "@/lib/api";
import { eligibleNode, isTaskActive, pendingAssistantOutput, selectedNodeProblem } from "@/lib/chat-state";

export const Route = createFileRoute("/")({ component: Workspace });
const decisionsSchema = { parse: (value: unknown) => {
  if (!value || typeof value !== "object" || !("decisions" in value) || !Array.isArray(value.decisions)) throw new Error("Invalid decision response.");
  return { decisions: value.decisions.map((decision) => decisionSchema.parse(decision)) };
} };

function Workspace() {
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:3100");
  const [token, setToken] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const connectAttempt = useRef<AbortController | null>(null);
  useEffect(() => () => connectAttempt.current?.abort(), []);

  async function connect(event: FormEvent) {
    event.preventDefault();
    setConnecting(true); setConnectionError("");
    const controller = new AbortController(); connectAttempt.current = controller;
    try {
      const next = { id: crypto.randomUUID(), baseUrl: normalizeBackendUrl(baseUrl), token: token.trim() };
      if (!next.token) throw new Error("Enter the backend operator token.");
      await apiRequest(next, "/v1/nodes", nodesResponseSchema, { signal: controller.signal });
      if (controller.signal.aborted) return;
      queryClient.clear(); setConnection(next); setToken(""); setSettingsOpen(false);
    } catch (error) { if (!controller.signal.aborted) setConnectionError(errorText(error)); }
    finally { if (!controller.signal.aborted) setConnecting(false); }
  }

  function disconnect() {
    connectAttempt.current?.abort(); setConnecting(false);
    setConnection(null); setToken(""); setConnectionError(""); queryClient.clear(); setSettingsOpen(true);
  }

  return <>
    <ChatWorkspace key={connection?.id ?? "disconnected"} connection={connection} onSettings={() => setSettingsOpen(true)} onDisconnect={disconnect} />
    {settingsOpen && <div className="settings-backdrop"><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
      <div className="settings-title"><Settings2 size={20} /><h2 id="connection-title">Connect your workspace</h2></div>
      <p>Connect to your backend to see available machines and start a conversation.</p>
      <form onSubmit={connect}>
        <label htmlFor="backend-url">Backend URL</label><input id="backend-url" type="url" required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} autoFocus disabled={connecting} />
        <label htmlFor="operator-token">Operator token</label><input id="operator-token" type="password" required autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} disabled={connecting} />
        <small>The token stays in this tab's memory and is cleared on disconnect or reload. Use HTTPS for a backend outside your local machine.</small>
        {connectionError && <p className="error-banner" role="alert">{connectionError}</p>}
        <div className="settings-actions"><Button type="button" variant="ghost" disabled={connecting} onClick={() => setSettingsOpen(false)}>Close</Button><Button disabled={connecting}>{connecting ? "Connecting…" : "Connect"}</Button></div>
      </form>
    </section></div>}
  </>;
}

type PendingSubmission = { conversationId: string; key: string; body: SubmitMessage };
function ChatWorkspace({ connection, onSettings, onDisconnect }: { connection: Connection | null; onSettings: () => void; onDisconnect: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [routing, setRouting] = useState("auto");
  const [workspaceId, setWorkspaceId] = useState("default");
  const [allowedTools, setAllowedTools] = useState<EnabledTool[]>([]);
  const [allowHostedJudgment, setAllowHostedJudgment] = useState(true);
  const [allowRulesFallback, setAllowRulesFallback] = useState(true);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [resumeId, setResumeId] = useState("");
  const [lastTaskId, setLastTaskId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pending, setPending] = useState<PendingSubmission | null>(null);
  const [actionError, setActionError] = useState("");
  const live = useRef(true);
  const submitLock = useRef(false);
  const actionAbort = useRef<AbortController | null>(null);
  const messageEnd = useRef<HTMLDivElement | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; actionAbort.current?.abort(); }; }, []);
  const prefix = ["control-plane", connection?.id] as const;
  const nodesQuery = useQuery({ queryKey: [...prefix, "nodes"], enabled: !!connection,
    queryFn: ({ signal }) => apiRequest(connection!, "/v1/nodes", nodesResponseSchema, { signal }), refetchInterval: 3_000, retry: false });
  const conversationQuery = useQuery({ queryKey: [...prefix, "conversation", conversationId], enabled: !!connection && !!conversationId,
    queryFn: ({ signal }) => apiRequest(connection!, `/v1/conversations/${conversationId}`, conversationSchema, { signal }), refetchInterval: 1_500, retry: false });
  const conversation = conversationQuery.data;
  const taskId = conversation?.activeTaskId ?? lastTaskId ?? conversation?.messages.slice().reverse().find((message) => message.taskId)?.taskId;
  const taskQuery = useQuery({ queryKey: [...prefix, "task", taskId], enabled: !!connection && !!taskId,
    queryFn: ({ signal }) => apiRequest(connection!, `/v1/tasks/${taskId}`, taskSchema, { signal }),
    refetchInterval: (query) => query.state.data?.status === "unknown" ? 3_000 : !query.state.data || isTaskActive(query.state.data.status) ? 750 : false, retry: false });
  const decisionsQuery = useQuery({ queryKey: [...prefix, "decisions", taskId], enabled: !!connection && !!taskId,
    queryFn: ({ signal }) => apiRequest(connection!, `/v1/tasks/${taskId}/decisions`, decisionsSchema, { signal }), retry: false });
  const task = taskQuery.data;
  const active = !!conversation?.activeTaskId || !!task && isTaskActive(task.status);
  const nodes = nodesQuery.data?.nodes ?? [];
  const onlineNodes = nodes.filter((node) => node.status === "online");
  const routingProblem = routing === "auto"
    ? nodes.some((node) => eligibleNode(node, workspaceId, allowedTools)) ? null : "No online node has a ready model, this workspace, and every requested tool."
    : selectedNodeProblem(nodes, routing, workspaceId, allowedTools);
  const output = pendingAssistantOutput(conversation, task);
  const latestDecision = decisionsQuery.data?.decisions.at(-1) ?? task?.decision;
  const suggestions = ["Explore a codebase", "Debug a failing test", "Plan a new feature"];
  useEffect(() => { if (task && !isTaskActive(task.status)) void conversationQuery.refetch(); }, [task?.status, task?.id]);
  useEffect(() => { if (conversation?.activeTaskId) setLastTaskId(conversation.activeTaskId); }, [conversation?.activeTaskId]);
  useEffect(() => { messageEnd.current?.scrollIntoView({ block: "nearest" }); }, [output, conversation?.messages.length]);

  async function performSubmit(existing?: PendingSubmission) {
    if (!connection || submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true); setActionError("");
    const controller = new AbortController(); actionAbort.current = controller;
    let submission = existing;
    try {
      if (!submission) {
        const current = conversationId
          ? await apiRequest(connection, `/v1/conversations/${conversationId}`, conversationSchema, { signal: controller.signal })
          : await apiRequest(connection, "/v1/conversations", conversationSchema, { method: "POST", body: {}, signal: controller.signal });
        if (!live.current) return;
        setConversationId(current.id); queryClient.setQueryData([...prefix, "conversation", current.id], current);
        if (current.activeTaskId) throw new Error("This conversation already has an active task. Wait for it or cancel it first.");
        submission = { conversationId: current.id, key: crypto.randomUUID(), body: {
          protocolVersion: PROTOCOL_VERSION, text: draft.trim(), expectedRevision: current.revision,
          routing: routing === "auto" ? { mode: "auto" } : { mode: "manual", nodeId: routing },
          policy: { workspaceId, allowedTools, allowHostedJudgment, allowRulesFallback },
        } };
        setPending(submission);
      }
      const result = await apiRequest(connection, `/v1/conversations/${submission.conversationId}/messages`, taskResponseSchema, { method: "POST", body: submission.body, idempotencyKey: submission.key, signal: controller.signal });
      if (!live.current) return;
      setPending(null); setDraft(""); setLastTaskId(result.task.id);
      queryClient.setQueryData([...prefix, "task", result.task.id], result.task);
      await queryClient.invalidateQueries({ queryKey: [...prefix, "conversation", submission.conversationId] });
    } catch (error) {
      if (!live.current) return;
      const uncertain = !!submission && submissionMayHaveSucceeded(error);
      setPending(uncertain ? submission! : null);
      setActionError(`${errorText(error)}${uncertain ? " Delivery is uncertain. Retry the same submission below; its idempotency key prevents a second task." : ""}`);
      if (conversationId) void queryClient.invalidateQueries({ queryKey: [...prefix, "conversation", conversationId] });
    } finally { submitLock.current = false; if (live.current) setSubmitting(false); }
  }

  async function cancelTask() {
    if (!connection || !taskId || cancelling) return;
    setCancelling(true); setActionError("");
    try {
      const result = await apiRequest(connection, `/v1/tasks/${taskId}/cancel`, taskSchema, { method: "POST", body: {} });
      if (!live.current) return;
      queryClient.setQueryData([...prefix, "task", result.id], result);
      void conversationQuery.refetch();
    } catch (error) { if (live.current) setActionError(errorText(error)); }
    finally { if (live.current) setCancelling(false); }
  }

  function newConversation() {
    if (active || submitting || pending) return;
    setConversationId(null); setLastTaskId(null); setDraft(""); setActionError(""); setResumeId("");
  }
  function resumeConversation(event: FormEvent) {
    event.preventDefault();
    if (active || submitting || pending) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resumeId.trim())) { setActionError("Enter a valid conversation ID."); return; }
    setConversationId(resumeId.trim()); setLastTaskId(null); setActionError("");
  }
  const sendDisabled = !connection || !draft.trim() || active || submitting || !!pending || !!nodesQuery.error || nodesQuery.isPending || !!routingProblem || !workspaceId.trim() || !!conversationQuery.error;

  return <div className="workspace-shell">
    <aside className="sidebar" aria-label="Workspace navigation">
      <a className="brand" href="/" aria-label="Curilo Agent home"><span className="brand-mark"><Layers3 size={21} /></span><span>Curilo Agent<small>YOUR WORKSPACE</small></span></a>
      <Button variant="outline" className="new-chat" disabled={active || submitting || !!pending} onClick={newConversation}><Plus /> New conversation</Button>
      <div className="sidebar-label">WORKSPACE</div><div className="nav-active"><MessageSquare size={16} /> Conversation<span className="nav-dot" /></div>
      <a className="nav-item" href="#connected-nodes"><Network size={16} /> Connected nodes<span className="count">{onlineNodes.length}</span></a>
      <button className="nav-item connection-control" onClick={onSettings}><Settings2 size={16} /> Connection settings</button>
      {connection && <button className="nav-item connection-control" onClick={onDisconnect}><Unplug size={16} /> Disconnect</button>}
      {connection && <form className="resume-form" onSubmit={resumeConversation}><label htmlFor="resume-id">Resume a conversation</label><input id="resume-id" value={resumeId} onChange={(event) => setResumeId(event.target.value)} placeholder="Conversation ID" /><Button variant="outline" size="sm" disabled={active || submitting || !!pending || !resumeId.trim()}>Open</Button></form>}
      <div className="sidebar-bottom"><span className="avatar">P</span><div>Personal workspace<small>{connection ? "Connected to your backend" : "Not connected"}</small></div><ShieldCheck size={16} /></div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><span className="breadcrumb">Workspace</span><span className="slash">/</span>{conversationId ? "Conversation" : "New conversation"}</div><button className={`connection-badge ${connection && !nodesQuery.error ? "is-connected" : ""}`} onClick={onSettings}><span />{!connection ? "Connect backend" : nodesQuery.error ? "Connection interrupted" : "Backend connected"}</button></header>
      {conversationId && <div className="conversation-reference">Conversation <code>{conversationId}</code><span>Save this ID to resume after reconnecting.</span></div>}
      <div className={`conversation-area ${conversationId ? "has-conversation" : ""}`}>
        {!conversationId ? <section className="welcome" aria-labelledby="welcome-heading"><div className="eyebrow"><span /> ONE AGENT. YOUR MACHINES.</div><h1 id="welcome-heading">What would you<br />like to build?</h1><p>Your agent finds the right machine for the job.<br className="desktop-break" /> Keep the conversation here, wherever the work runs.</p><div className="suggestions">{suggestions.map((suggestion, index) => <button key={suggestion} onClick={() => setDraft(suggestion)}><span className="suggestion-icon">{index === 0 ? <Terminal size={18} /> : index === 1 ? <Cpu size={18} /> : <Sparkles size={18} />}</span>{suggestion}<ArrowUpRight size={15} /></button>)}</div></section>
        : <section className="message-list" aria-label="Conversation messages" aria-busy={conversationQuery.isPending}>
          {conversationQuery.isPending && <p className="muted-note">Loading conversation…</p>}
          {conversation?.messages.map((message) => <article className={`chat-message ${message.role}`} key={message.id}><div className="message-role">{message.role === "user" ? "You" : "Curilo Agent"}</div><div className="message-text">{message.text}</div></article>)}
          {task && output !== null && (output || isTaskActive(task.status)) && <article className="chat-message assistant"><div className="message-role">Curilo Agent <span>{task.status}</span></div><div className="message-text">{output || "Waiting for the model…"}</div></article>}
          {task?.error && <p className="error-banner" role="alert">{task.error}</p>}
          {task?.status === "unknown" && <p className="error-banner">Execution outcome is unknown. The task is not automatically replayed; inspect the node before repeating any tool action.</p>}
          {task?.status === "cancelled" && <p className="muted-note">Task cancelled. Tool actions completed before cancellation may remain.</p>}
          <div ref={messageEnd} />
        </section>}
        {(conversationQuery.error || taskQuery.error) && <p className="error-banner" role="alert">{errorText(conversationQuery.error ?? taskQuery.error)} <button onClick={() => { void conversationQuery.refetch(); if (taskId) void taskQuery.refetch(); }}>Refresh status</button></p>}
        {latestDecision && <section className="decision-strip" aria-label="Routing decision"><Sparkles size={15} /><div><strong>{nodes.find((node) => node.nodeId === latestDecision.nodeId)?.name ?? latestDecision.nodeId} · {latestDecision.profileId}</strong><p>{latestDecision.reason}</p><small>{latestDecision.provider === "jev" ? "Jev judgment" : "Rules fallback"} · {Math.round(latestDecision.latencyMs)} ms routing · {task?.status}</small></div></section>}
        {decisionsQuery.error && <p className="muted-note">Decision history unavailable: {errorText(decisionsQuery.error)}</p>}
        <section className="composer-area" aria-label="Message composer">
          <form className="composer" onSubmit={(event) => { event.preventDefault(); if (!sendDisabled) void performSubmit(); }}>
            <label className="sr-only" htmlFor="message">Message your agent</label><textarea id="message" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              if (!event.repeat) event.currentTarget.form?.requestSubmit();
            }} maxLength={32_000} placeholder="Describe a task, ask a question, or share an idea…" rows={3} disabled={submitting || !!pending} />
            <div className="composer-toolbar"><label className="route-select"><Sparkles size={14} /><select aria-label="Routing mode or pinned node" value={routing} disabled={submitting || !!pending} onChange={(event) => setRouting(event.target.value)}><option value="auto">Automatic routing</option>{routing !== "auto" && !nodes.some((node) => node.nodeId === routing) && <option value={routing}>Pinned node · unavailable</option>}{nodes.map((node) => <option key={node.nodeId} value={node.nodeId}>{node.name} · {node.status}</option>)}</select></label>{active ? <Button type="button" variant="outline" size="sm" onClick={() => void cancelTask()} disabled={cancelling}><Square />{cancelling ? "Cancelling…" : "Cancel"}</Button> : <Button type="submit" size="icon" disabled={sendDisabled} aria-label="Send message" aria-describedby="send-status"><ArrowUp /></Button>}</div>
            <details className="task-options"><summary>Task permissions and routing policy</summary><label className="workspace-field">Workspace ID<input value={workspaceId} maxLength={128} disabled={submitting || !!pending} onChange={(event) => setWorkspaceId(event.target.value)} /></label><fieldset disabled={submitting || !!pending}><legend>Allowed tools for this task</legend><div className="tool-options">{enabledToolSchema.options.map((tool) => <label key={tool}><input type="checkbox" checked={allowedTools.includes(tool)} onChange={(event) => setAllowedTools((current) => event.target.checked ? [...current, tool] : current.filter((item) => item !== tool))} />{tool}</label>)}</div></fieldset><p className="permission-note">Tools are off by default. Bash can execute commands. Enabled tools use the configured working directory; they are not a sandbox.</p><label className="policy-check"><input type="checkbox" checked={allowHostedJudgment} disabled={submitting || !!pending} onChange={(event) => setAllowHostedJudgment(event.target.checked)} />Allow hosted Jev judgment to inspect routing context</label><label className="policy-check"><input type="checkbox" checked={allowRulesFallback} disabled={submitting || !!pending} onChange={(event) => setAllowRulesFallback(event.target.checked)} />Allow deterministic rules if Jev is unavailable or disabled</label></details>
          </form>
          {actionError && <p className="error-banner" role="alert">{actionError}</p>}
          {pending && !submitting && <Button variant="outline" onClick={() => void performSubmit(pending)}><RefreshCw /> Retry same submission</Button>}
          <p id="send-status" className="composer-note">{!connection ? "Connect your backend to begin." : submitting ? "Submitting your task…" : pending ? "Resolve the pending submission before starting another task." : task?.status === "unknown" ? "Execution outcome is unknown. Waiting for the backend to reconcile; this task will not be replayed." : active ? "Your task is running. Output refreshes automatically." : nodesQuery.error ? "Node availability cannot be verified while the backend is unreachable." : routingProblem ?? "Ready. Your selected permissions apply only to the next task."}</p>
        </section>
      </div>
    </main>
    <aside id="connected-nodes" className="fleet-panel" aria-labelledby="fleet-heading"><div className="fleet-heading"><h2 id="fleet-heading">Your nodes</h2><span className="count">{onlineNodes.length}/{nodes.length}</span>{connection && <button className="icon-refresh" aria-label="Refresh nodes" onClick={() => void nodesQuery.refetch()}><RefreshCw size={13} /></button>}</div><p className="fleet-description">The machines behind your agent.</p>
      {nodesQuery.error && <p className="error-banner" role="alert">{errorText(nodesQuery.error)} Cached nodes may be stale.</p>}
      {connection && nodesQuery.isPending ? <p className="muted-note">Loading nodes…</p> : nodes.length ? <div className="node-list">{nodes.map((node) => <NodeCard key={node.nodeId} node={node} pinned={routing === node.nodeId} onPin={() => setRouting(node.nodeId)} disabled={submitting || !!pending} />)}</div> : <div className="empty-fleet"><div className="empty-icon"><Network size={28} /></div><h3>{connection ? "No nodes registered" : "No backend connected"}</h3><p>{connection ? "Start a node agent on a machine to make its models and enabled tools available here." : "Connect your backend to discover your machines."}</p><span className="waiting"><Radio size={13} />{connection ? "Checking every 3 seconds" : "Connection required"}</span></div>}
      <div className="routing-card"><span className="routing-icon"><Sparkles size={17} /></span><h3>{routing === "auto" ? "Automatic routing" : "Explicit node routing"}</h3><p>{routing === "auto" ? "Jev or permitted rules select among eligible machines." : "Tasks stay pinned to this node. An unavailable node will not silently be replaced."}</p><div><Check size={13} /> One continuous conversation</div><div><Check size={13} /> Permissions checked before routing</div></div><div className="fleet-footer"><ShieldCheck size={15} /><span>Only explicitly enabled tools<br />are available to your agent.</span></div>
    </aside>
  </div>;
}

function NodeCard({ node, pinned, onPin, disabled }: { node: FleetNode; pinned: boolean; onPin: () => void; disabled: boolean }) {
  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  return <article className={`node-card ${pinned ? "is-pinned" : ""}`}><div className="node-title"><Cpu size={15} /><h3>{node.name}</h3><span className={`node-status ${node.status}`}>{node.status}</span></div><p>{node.hardware.platform} · {node.hardware.arch} · {node.hardware.cpuCores} cores</p><p>{gb(node.hardware.availableMemoryBytes)} free / {gb(node.hardware.memoryBytes)}</p>{node.hardware.gpus.map((gpu, index) => <p key={`${gpu.name}-${index}`}>{gpu.name}{gpu.memoryBytes ? ` · ${gb(gpu.memoryBytes)}` : ""}</p>)}<div className="node-models">{node.profiles.length ? node.profiles.map((profile) => <ModelRow key={profile.id} profile={profile} />) : <p>No models discovered yet. Start Ollama or configure a runtime.</p>}</div><p className="node-tools">Tools: {node.enabledTools.join(", ") || "none"}</p><p className="node-tools">Workspaces: {node.workspaceIds.join(", ")}</p><p className="node-tools">Active tasks: {node.activeAttempts.length}</p><Button type="button" variant={pinned ? "default" : "outline"} size="sm" disabled={disabled} onClick={onPin}>{pinned ? "Pinned for next task" : "Route to this node"}</Button></article>;
}

function ModelRow({ profile }: { profile: ModelProfile }) {
  const discovery = profile.discovery;
  return <div className="model-row">
    <div><span title={profile.modelId}>{profile.modelId}</span><strong className={profile.state}>{discovery?.selected ? `selected · ${profile.state}` : profile.state === 'starting' && discovery ? 'benchmarking' : profile.state}</strong></div>
    {discovery && <p>
      {discovery.parameterCount !== undefined && `${(discovery.parameterCount / 1e9).toFixed(1)}B · `}
      {discovery.tokensPerSecond !== undefined && <span title={discovery.measuredAt ? `Measured ${new Date(discovery.measuredAt).toLocaleString()}; slower of two generation samples` : undefined}>{discovery.tokensPerSecond.toFixed(1)} tokens/s · </span>}
      {discovery.reason}
    </p>}
  </div>;
}
