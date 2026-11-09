import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  projectsResponseSchema,
  projectSchema,
  type FleetNode,
} from "@agent/contracts";
import { FolderCode, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  parseRepositories,
  type WorkspaceRepository,
} from "@/lib/workspace-repositories";
import { apiRequest, errorText, type Connection } from "@/lib/api";
import { ProjectTree } from "@/components/project-tree";

export function WorkspaceList({
  nodes,
  connection,
  loading,
  error,
}: {
  nodes: FleetNode[];
  connection: Connection | null;
  loading: boolean;
  error: string | null;
}) {
  const queryClient = useQueryClient();
  const [addingNode, setAddingNode] = useState<FleetNode | null>(null);
  async function addRepository(nodeId: string, directory: string) {
    if (!connection) return;
    await apiRequest(
      connection,
      `/v1/nodes/${nodeId}/projects`,
      projectSchema,
      { method: "POST", body: { directory } },
    );
    await queryClient.invalidateQueries({
      queryKey: ["projects", connection.id, nodeId],
    });
    setAddingNode(null);
  }
  return (
    <section className="workspace-navigation" aria-label="Workspaces">
      <div className="sidebar-label">WORKSPACE</div>
      {!connection ? (
        <p className="workspace-note">
          Connect your backend to see workspaces.
        </p>
      ) : loading ? (
        <p className="workspace-note" role="status">
          Loading workspaces…
        </p>
      ) : !error && nodes.length === 0 ? (
        <p className="workspace-note">Your nodes will appear here.</p>
      ) : null}
      {error && (
        <p className="workspace-list-error" role="alert">
          {error}
        </p>
      )}
      <ul className="workspace-list">
        {nodes.map((node) => (
          <li key={node.nodeId}>
            <div className="workspace-node-heading">
              <span title={`Projects@${node.name}`}>Projects@{node.name}</span>
              <button
                type="button"
                className="workspace-add"
                aria-label={`Add code repo to Projects@${node.name}`}
                title="Add a code repo"
                disabled={!connection || node.status !== "online" || !!error}
                onClick={() => setAddingNode(node)}
              >
                <Plus size={15} aria-hidden="true" />
              </button>
            </div>
            {connection && <NodeProjects node={node} connection={connection} />}
          </li>
        ))}
      </ul>
      {addingNode && (
        <RepositoryDialog
          node={addingNode}
          onAdd={(directory) => addRepository(addingNode.nodeId, directory)}
          onClose={() => setAddingNode(null)}
        />
      )}
    </section>
  );
}

function NodeProjects({
  node,
  connection,
}: {
  node: FleetNode;
  connection: Connection;
}) {
  const queryClient = useQueryClient();
  const [migrationError, setMigrationError] = useState("");
  const [links, setLinks] = useState<WorkspaceRepository[]>([]);
  // Preserve directories saved by older clients, without making browser storage
  // a prerequisite for the node's automatic chat_sessions project.
  useEffect(() => {
    if (node.status !== "online") return;
    let cancelled = false;
    void (async () => {
      try {
        const saved = parseRepositories(
          localStorage.getItem(
            `curilo:workspace-repositories:${connection.baseUrl}`,
          ),
        ).filter((project) => project.nodeId === node.nodeId);
        if (!cancelled) setLinks(saved.filter((project) => project.url));
        const results = await Promise.allSettled(
          saved
            .filter((p) => p.directory !== undefined)
            .map((p) =>
              apiRequest(
                connection,
                `/v1/nodes/${node.nodeId}/projects`,
                projectSchema,
                { method: "POST", body: { directory: p.directory } },
              ),
            ),
        );
        if (!cancelled && results.some((r) => r.status === "rejected"))
          setMigrationError(
            "Some saved project directories could not be imported. Add them again using +.",
          );
        if (!cancelled && results.length)
          await queryClient.invalidateQueries({
            queryKey: ["projects", connection.id, node.nodeId],
          });
      } catch {
        if (!cancelled)
          setMigrationError(
            "Browser-saved projects could not be loaded. Node projects remain available.",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection.id, node.nodeId, node.status]);
  const projects = useQuery({
    queryKey: ["projects", connection.id, node.nodeId],
    queryFn: ({ signal }) =>
      apiRequest(
        connection,
        `/v1/nodes/${node.nodeId}/projects`,
        projectsResponseSchema,
        { signal },
      ),
    enabled: node.status === "online",
    refetchInterval: 5000,
    retry: false,
  });
  return (
    <>
      {projects.isPending && (
        <p className="workspace-note">
          {node.status === "online" ? "Loading projects…" : "Node offline"}
        </p>
      )}
      {projects.error && (
        <p className="workspace-list-error" role="alert">
          {errorText(projects.error)}{" "}
          <button onClick={() => void projects.refetch()}>Retry</button>
        </p>
      )}
      {migrationError && (
        <p className="workspace-list-error" role="alert">
          {migrationError}
        </p>
      )}
      {projects.data && (
        <ul
          className="project-tree"
          role="tree"
          aria-label={`Projects on ${node.name}`}
        >
          {projects.data.projects.map((project) => (
            <ProjectTree
              key={project.id}
              project={project}
              nodeId={node.nodeId}
              connection={connection}
              online={node.status === "online"}
            />
          ))}
        </ul>
      )}
      {projects.data?.projects.length === 0 && (
        <p className="workspace-note">Click + to add a code repo</p>
      )}
      {links.length > 0 && (
        <ul className="repository-list">
          {links.map((link) => (
            <li key={link.url}>
              <a
                className="repository-entry"
                href={link.url}
                target="_blank"
                rel="noreferrer"
              >
                <FolderCode size={14} aria-hidden="true" />
                <span>{link.name}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function RepositoryDialog({
  node,
  onAdd,
  onClose,
}: {
  node: FleetNode;
  onAdd: (directory: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const directoryInput = useRef<HTMLInputElement>(null);
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    directoryInput.current?.focus();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onAdd(directory);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not add the code repo.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="settings-dialog repository-dialog"
      aria-labelledby="repository-title"
      onClose={onClose}
    >
      <div className="settings-title">
        <FolderCode size={20} aria-hidden="true" />
        <h2 id="repository-title">Add a code repo</h2>
        <button
          type="button"
          className="icon-refresh"
          aria-label="Close add code repo"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <p>
        Add a directory on {node.name}. It can be a Git repo or any other code
        folder.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="repository-directory">Code Repo Directory</label>
        <input
          ref={directoryInput}
          id="repository-directory"
          type="text"
          value={directory}
          onChange={(event) => setDirectory(event.target.value)}
          placeholder="/path/to/code-directory"
          required
          autoFocus
        />
        <small>Directories are validated and saved on this node.</small>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <div className="settings-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Adding…" : "Add code repo"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
