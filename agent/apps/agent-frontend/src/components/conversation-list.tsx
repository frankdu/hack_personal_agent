import type { ConversationSummary } from "@agent/contracts";
import { Link } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";

export function ConversationList({
  conversations,
  selectedId,
  loading,
  error,
  disabled,
  onRetry,
}: {
  conversations: ConversationSummary[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  onRetry: () => void;
}) {
  return (
    <nav className="conversation-history" aria-label="Conversations">
      <div className="sidebar-label">CONVERSATIONS</div>
      {loading && (
        <p className="conversation-list-note" role="status">
          Loading conversations…
        </p>
      )}
      {error && (
        <div className="conversation-list-error" role="alert">
          <p>Could not load conversations. {error}</p>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
      {!loading && !error && conversations.length === 0 && (
        <p className="conversation-list-note">No conversations yet.</p>
      )}
      <ul className="conversation-list">
        {conversations.map((conversation) => (
          <li key={conversation.id}>
            <Link
              to="/conversations/$conversationId"
              params={{ conversationId: conversation.id }}
              className={`conversation-link ${selectedId === conversation.id ? "is-selected" : ""}`}
              aria-current={selectedId === conversation.id ? "page" : undefined}
              title={conversation.title}
              disabled={disabled}
            >
              <MessageSquare size={15} aria-hidden="true" />
              <span className="conversation-link-text">
                <span className="conversation-title">{conversation.title}</span>
                <time dateTime={conversation.updatedAt}>
                  {conversation.updatedAt.slice(0, 10)}
                </time>
              </span>
              {conversation.activeTaskId && (
                <span className="nav-dot" aria-label="Task in progress" />
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
