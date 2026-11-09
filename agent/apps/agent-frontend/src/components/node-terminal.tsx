import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Terminal as TerminalIcon, X } from "lucide-react";
import {
  projectsResponseSchema,
  terminalListSchema,
  terminalSessionSchema,
  terminalTicketSchema,
  terminalServerFrameSchema,
  type FleetNode,
  type TerminalSession,
} from "@agent/contracts";
import { apiRequest, errorText, type Connection } from "@/lib/api";
import { Button } from "@/components/ui/button";

const live = (s: TerminalSession) =>
  s.state === "attached" || s.state === "detached";
export function NodeTerminal({
  node,
  connection,
}: {
  node: FleetNode;
  connection: Connection;
}) {
  const [open, setOpen] = useState(false);
  const [workspace, setWorkspace] = useState(node.workspaceIds[0] ?? "default");
  const [backend, setBackend] = useState<"tmux" | "pty">("tmux");
  const [selected, setSelected] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [takeover, setTakeover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<{
    sessionId: string;
    workspaceId: string;
    backend: "tmux" | "pty";
    cols: number;
    rows: number;
  } | null>(null);
  const lock = useRef(false);
  const list = useQuery({
    queryKey: ["terminals", connection.id, node.nodeId],
    enabled: open && node.status === "online",
    queryFn: ({ signal }) =>
      apiRequest(
        connection,
        `/v1/nodes/${node.nodeId}/terminals`,
        terminalListSchema,
        { signal },
      ),
    refetchInterval: open ? 3000 : false,
  });
  const projects = useQuery({
    queryKey: ["projects", connection.id, node.nodeId],
    enabled: open && node.status === "online",
    queryFn: ({ signal }) =>
      apiRequest(
        connection,
        `/v1/nodes/${node.nodeId}/projects`,
        projectsResponseSchema,
        { signal },
      ),
  });
  const session = list.data?.sessions.find((s) => s.sessionId === selected);
  async function create() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const input = pending.current ?? {
      sessionId: crypto.randomUUID(),
      workspaceId: workspace,
      backend,
      cols: 100,
      rows: 28,
    };
    pending.current = input;
    try {
      const result = await apiRequest(
        connection,
        `/v1/nodes/${node.nodeId}/terminals`,
        terminalSessionSchema,
        { method: "POST", body: input },
      );
      pending.current = null;
      await list.refetch();
      setTakeover(false);
      setSelected(result.sessionId);
      setAttempt((n) => n + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function end(s: TerminalSession) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await apiRequest(
        connection,
        `/v1/terminals/${s.sessionId}/end`,
        terminalSessionSchema,
        { method: "POST" },
      );
      if (selected === s.sessionId) setSelected(null);
      await list.refetch();
    } catch (e) {
      setError(errorText(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function attach(s: TerminalSession, force = false) {
    setSelected(s.sessionId);
    setTakeover(force);
    setAttempt((n) => n + 1);
  }
  return (
    <section className="node-terminal" aria-label={`Terminals on ${node.name}`}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={node.status !== "online"}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <TerminalIcon size={15} /> {open ? "Hide terminals" : "Open terminal"}
      </Button>
      {open && (
        <div className="terminal-manager">
          <p className="terminal-help">
            Shell access runs as the node’s OS user, with that user’s command
            permissions. No model is required.
          </p>
          {list.isPending && <p role="status">Loading terminal sessions…</p>}
          {list.error && (
            <p className="error-banner" role="alert">
              {errorText(list.error)}
            </p>
          )}
          {list.data && (
            <>
              <div className="terminal-create">
                <label>
                  Workspace
                  <select
                    value={workspace}
                    disabled={busy || !!pending.current}
                    onChange={(e) => setWorkspace(e.target.value)}
                  >
                    {node.workspaceIds.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                    {projects.data?.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Session type
                  <select
                    value={backend}
                    disabled={busy || !!pending.current}
                    onChange={(e) =>
                      setBackend(e.target.value as "tmux" | "pty")
                    }
                  >
                    <option value="tmux" disabled={!list.data.capability.tmux}>
                      Persistent (tmux)
                    </option>
                    <option value="pty">Temporary (ends on disconnect)</option>
                  </select>
                </label>
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    busy ||
                    !list.data.capability.available ||
                    node.status !== "online" ||
                    (backend === "tmux" && !list.data.capability.tmux)
                  }
                  onClick={() => void create()}
                >
                  {busy
                    ? "Working…"
                    : pending.current
                      ? "Retry open terminal"
                      : "New terminal"}
                </Button>
              </div>
              <p className="terminal-help">
                {list.data.capability.shellLocation === "container"
                  ? "Container shell"
                  : "Host shell"}{" "}
                · {list.data.capability.maxSessions} sessions maximum · idle
                expiry {Math.round(list.data.capability.idleTimeoutMs / 60000)}{" "}
                min · maximum lifetime{" "}
                {Math.round(list.data.capability.maxLifetimeMs / 3600000)} h
              </p>
              {!list.data.capability.tmux && (
                <p className="terminal-help">
                  tmux is unavailable on this node. Install tmux for persistent
                  sessions, or select Temporary. Temporary shells end when
                  detached.
                </p>
              )}
              {list.data.capability.reason && (
                <p role="status">{list.data.capability.reason}</p>
              )}
              {list.data.sessions.length === 0 && (
                <p className="terminal-help">No terminal sessions yet.</p>
              )}
              <ul className="terminal-sessions">
                {list.data.sessions
                  .filter(
                    (s, index) => live(s) || s.state === "ending" || index < 16,
                  )
                  .map((s) => (
                    <li key={s.sessionId}>
                      <span title={s.sessionId}>
                        {s.sessionId.slice(0, 8)} · {s.backend} · {s.state}
                      </span>
                      <span className="terminal-session-actions">
                        {live(s) && (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={busy || node.status !== "online"}
                              onClick={() => attach(s)}
                            >
                              {s.state === "attached" ? "Attach" : "Reconnect"}
                            </Button>
                            {s.state === "attached" && s.backend === "tmux" && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => attach(s, true)}
                              >
                                Take over
                              </Button>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void end(s)}
                            >
                              End session
                            </Button>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
              </ul>
            </>
          )}
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          {selected && session && live(session) && (
            <div className="terminal-view">
              <div className="terminal-view-heading">
                <span>
                  {session.shellLocation === "host" ? "Host" : "Container"}{" "}
                  shell · {session.osUserRef} · {session.sessionId.slice(0, 8)}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Detach terminal"
                  onClick={() => setSelected(null)}
                >
                  <X size={16} />
                </button>
              </div>
              <TerminalViewport
                key={`${selected}:${attempt}`}
                connection={connection}
                session={session}
                takeover={takeover}
              />
              <p className="terminal-help">
                {session.backend === "tmux"
                  ? "Closing this view detaches the terminal; commands keep running until the session ends or expires."
                  : "Temporary shell: closing this view ends the shell."}{" "}
                Expires {new Date(session.expiresAt).toLocaleString()}.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function TerminalViewport({
  connection,
  session,
  takeover,
}: {
  connection: Connection;
  session: TerminalSession;
  takeover: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let terminal: import("@xterm/xterm").Terminal | undefined;
    let observer: ResizeObserver | undefined;
    let ready = false;
    const controller = new AbortController();
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !host.current) return;
      terminal = new Terminal({
        cursorBlink: true,
        scrollback: 5000,
        fontSize: 13,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        theme: { background: "#101419", foreground: "#e2e8f0" },
        allowProposedApi: false,
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host.current);
      fit.fit();
      const size = () => ({
        cols: Math.max(2, Math.min(500, terminal!.cols)),
        rows: Math.max(2, Math.min(200, terminal!.rows)),
      });
      const ticket = await apiRequest(
        connection,
        `/v1/terminals/${session.sessionId}/ticket`,
        terminalTicketSchema,
        {
          method: "POST",
          body: { clientId: connection.id, takeover },
          signal: controller.signal,
        },
      );
      if (disposed) return;
      const url = new URL(`${connection.baseUrl}/v1/terminals/attach`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      const send = (frame: object) => {
        if (socket?.readyState === WebSocket.OPEN && ready)
          socket.send(JSON.stringify(frame));
      };
      socket.onopen = () =>
        socket!.send(
          JSON.stringify({ type: "attach", ticket: ticket.ticket, ...size() }),
        );
      socket.onmessage = (event) => {
        try {
          const frame = terminalServerFrameSchema.parse(
            JSON.parse(String(event.data)),
          );
          if (frame.type === "ready") {
            ready = true;
            setStatus("Connected");
            terminal!.focus();
            send({ type: "resize", ...size() });
          } else if (frame.type === "output") {
            const bytes = new TextEncoder().encode(frame.data).byteLength;
            terminal!.write(frame.data, () => send({ type: "ack", bytes }));
          } else if (frame.type === "error") setError(frame.message);
          else {
            ready = false;
            setStatus(frame.reason);
          }
        } catch {
          setError("Invalid terminal response. Reconnect to try again.");
          socket?.close();
        }
      };
      socket.onerror = () => {
        if (!disposed)
          setError(
            "The terminal connection failed. Check the backend address and reconnect.",
          );
      };
      socket.onclose = (event) => {
        ready = false;
        if (!disposed)
          setStatus(
            `Disconnected${event.reason ? `: ${event.reason}` : ""}. Use Reconnect to attach again.`,
          );
      };
      terminal.onData((data) => {
        if (!ready || socket?.readyState !== WebSocket.OPEN) return;
        if (
          socket.bufferedAmount > 65536 ||
          new TextEncoder().encode(data).byteLength > 65536
        ) {
          setError("Terminal input is too large. Paste a smaller block.");
          return;
        }
        const characters = Array.from(data);
        for (let i = 0; i < characters.length; i += 2048)
          send({ type: "input", data: characters.slice(i, i + 2048).join("") });
      });
      observer = new ResizeObserver(() => {
        if (!disposed) {
          fit.fit();
          send({ type: "resize", ...size() });
        }
      });
      observer.observe(host.current!);
    })().catch((e) => {
      if (!disposed) {
        setStatus("Disconnected");
        setError(errorText(e));
      }
    });
    return () => {
      disposed = true;
      controller.abort();
      observer?.disconnect();
      socket?.close();
      terminal?.dispose();
    };
  }, [connection, session.sessionId, takeover]);
  return (
    <>
      <p className="terminal-status" role="status">
        {status}
      </p>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <div
        className="terminal-screen"
        ref={host}
        aria-label="Interactive terminal"
      />
    </>
  );
}
