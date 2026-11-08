import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowUp, ArrowUpRight, Check, Cpu, Layers3, MessageSquare, Network, Plus, Radio, ShieldCheck, Sparkles, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({ component: Workspace });

function Workspace() {
  const [draft, setDraft] = useState("");
  const [routing, setRouting] = useState("auto");
  const suggestions = ["Explore a codebase", "Debug a failing test", "Plan a new feature"];

  return (
    <div className="workspace-shell">
      <aside className="sidebar" aria-label="Workspace navigation">
        <a className="brand" href="/" aria-label="Personal Agent home"><span className="brand-mark"><Layers3 size={21} /></span><span>Personal Agent<small>YOUR WORKSPACE</small></span></a>
        <Button variant="outline" className="new-chat" onClick={() => setDraft("")}><Plus /> New conversation</Button>
        <div className="sidebar-label">WORKSPACE</div>
        <div className="nav-active"><MessageSquare size={16} /> Conversation<span className="nav-dot" /></div>
        <a className="nav-item" href="#connected-nodes"><Network size={16} /> Connected nodes<span className="count">0</span></a>
        <div className="sidebar-bottom"><span className="avatar">P</span><div>Personal workspace<small>Local development</small></div><ShieldCheck size={16} /></div>
      </aside>

      <main className="main-content">
        <header className="topbar"><div><span className="breadcrumb">Workspace</span><span className="slash">/</span>New conversation</div><span className="connection-badge"><span /> Backend not connected</span></header>
        <div className="conversation-area">
          <section className="welcome" aria-labelledby="welcome-heading">
            <div className="eyebrow"><span /> ONE AGENT. YOUR MACHINES.</div>
            <h1 id="welcome-heading">What would you<br />like to build?</h1>
            <p>Your agent will find the right machine for the job.<br className="desktop-break" /> Keep the conversation here, wherever the work runs.</p>
            <div className="suggestions">{suggestions.map((suggestion, index) => <button key={suggestion} onClick={() => setDraft(suggestion)}><span className="suggestion-icon">{index === 0 ? <Terminal size={18} /> : index === 1 ? <Cpu size={18} /> : <Sparkles size={18} />}</span>{suggestion}<ArrowUpRight size={15} /></button>)}</div>
          </section>

          <section className="composer-area" aria-label="Message composer">
            <div className="composer">
              <label className="sr-only" htmlFor="message">Message your agent</label>
              <textarea id="message" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Describe a task, ask a question, or share an idea…" rows={3} />
              <div className="composer-toolbar"><label className="route-select"><Sparkles size={14} /><span className="sr-only">Routing mode</span><select aria-label="Routing mode" value={routing} onChange={(event) => setRouting(event.target.value)}><option value="auto">Automatic routing</option><option value="manual" disabled>Choose a node · none connected</option></select></label><Button size="icon" disabled aria-label="Send message" aria-describedby="send-status"><ArrowUp /></Button></div>
            </div>
            <p id="send-status" className="composer-note">Chat will be available once the backend and a node are connected.</p>
          </section>
        </div>
      </main>

      <aside id="connected-nodes" className="fleet-panel" aria-labelledby="fleet-heading">
        <div className="fleet-heading"><h2 id="fleet-heading">Your nodes</h2><span className="count">0</span></div>
        <p className="fleet-description">The machines behind your agent.</p>
        <div className="empty-fleet"><div className="empty-icon"><Network size={28} /></div><h3>No nodes connected</h3><p>Start a node agent on a machine to make its models and enabled tools available here.</p><span className="waiting"><Radio size={13} /> Awaiting backend integration</span></div>
        <div className="routing-card"><span className="routing-icon"><Sparkles size={17} /></span><h3>Designed for automatic routing</h3><p>Tasks will be matched to available models, tools, and machine capacity.</p><div><Check size={13} /> One continuous conversation</div><div><Check size={13} /> Choose a node when you need to</div></div>
        <div className="fleet-footer"><ShieldCheck size={15} /><span>Only explicitly enabled tools<br />will be available to your agent.</span></div>
      </aside>
    </div>
  );
}
