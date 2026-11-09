import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  LoaderCircle,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";

export function ChatMessage({
  role,
  text,
  status,
  onDelete,
  deleteDisabledReason,
}: {
  role: "user" | "assistant";
  text: string;
  status?: string;
  onDelete?: () => Promise<void>;
  deleteDisabledReason?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timeout);
  }, [copied]);

  async function copy() {
    setError("");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError(
        "Could not copy this message. Check clipboard permissions and try again.",
      );
    }
  }

  async function remove() {
    if (!onDelete || deleting || deleteDisabledReason) return;
    setDeleting(true);
    setError("");
    try {
      await onDelete();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not delete this message.",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <article className={`chat-message ${role}`}>
      <div className="message-bubble">
        <div className="message-role">
          {role === "user" ? "You" : "Curilo Agent"}
          {status && <span>{status}</span>}
        </div>
        <div className="message-text">{text}</div>
      </div>
      <div
        className="message-actions"
        role="group"
        aria-label="Message actions"
      >
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy message"}
          title={copied ? "Copied" : "Copy"}
          onClick={() => void copy()}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="message-delete"
          aria-label="Delete message"
          title={deleteDisabledReason ?? "Delete"}
          disabled={!onDelete || !!deleteDisabledReason || deleting}
          onClick={() => void remove()}
        >
          {deleting ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 aria-hidden="true" />
          )}
        </button>
        <button type="button" aria-label="Like message" title="Like">
          <ThumbsUp aria-hidden="true" />
        </button>
        <button type="button" aria-label="Dislike message" title="Dislike">
          <ThumbsDown aria-hidden="true" />
        </button>
      </div>
      <span className="sr-only" role="status">
        {copied ? "Message copied to clipboard." : ""}
      </span>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
