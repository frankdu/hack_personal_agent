import { useEffect, useRef, useState, type FormEvent } from "react";
import type { FleetNode } from "@agent/contracts";
import { FolderCode, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  parseRepositories,
  repositoryDetails,
  type WorkspaceRepository,
} from "@/lib/workspace-repositories";

export function WorkspaceList({
  nodes,
  backendUrl,
  loading,
  error,
}: {
  nodes: FleetNode[];
  backendUrl: string | null;
  loading: boolean;
  error: string | null;
}) {
  const storageKey = `curilo:workspace-repositories:${backendUrl}`;
  const [repositories, setRepositories] = useState<
    WorkspaceRepository[] | null
  >(null);
  const [storageError, setStorageError] = useState("");
  const [addingNode, setAddingNode] = useState<FleetNode | null>(null);

  function loadRepositories() {
    try {
      setRepositories(parseRepositories(localStorage.getItem(storageKey)));
      setStorageError("");
    } catch {
      setStorageError("Could not load saved code repos from this browser.");
    }
  }

  useEffect(() => {
    if (backendUrl) loadRepositories();
  }, [storageKey]);

  function addRepository(nodeId: string, directory: string) {
    if (!repositories) throw new Error("Saved code repos are not available.");
    const repository = { nodeId, ...repositoryDetails(directory) };
    if (
      repositories.some(
        (item) =>
          item.nodeId === nodeId &&
          item.directory !== undefined &&
          item.directory.replace(/[\\/]+$/, "") ===
            repository.directory.replace(/[\\/]+$/, ""),
      )
    ) {
      throw new Error(
        "This code repo has already been added to this workspace.",
      );
    }
    const next = [...repositories, repository];
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      throw new Error(
        "Could not save the code repo. Check browser storage access.",
      );
    }
    setRepositories(next);
    setAddingNode(null);
  }

  return (
    <section className="workspace-navigation" aria-label="Workspaces">
      <div className="sidebar-label">WORKSPACE</div>
      {!backendUrl ? (
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
      {storageError && (
        <div className="workspace-list-error" role="alert">
          {storageError} <button onClick={loadRepositories}>Retry</button>
        </div>
      )}
      <ul className="workspace-list">
        {nodes.map((node) => {
          const repos = repositories?.filter(
            (repo) => repo.nodeId === node.nodeId,
          );
          return (
            <li key={node.nodeId}>
              <div className="workspace-node-heading">
                <span title={`Projects@${node.name}`}>
                  Projects@{node.name}
                </span>
                <button
                  type="button"
                  className="workspace-add"
                  aria-label={`Add code repo to Projects@${node.name}`}
                  title="Add a code repo"
                  disabled={!repositories || !!error}
                  onClick={() => setAddingNode(node)}
                >
                  <Plus size={15} aria-hidden="true" />
                </button>
              </div>
              {repos?.length ? (
                <ul className="repository-list">
                  {repos.map((repo) => {
                    const content = (
                      <>
                        <FolderCode size={14} aria-hidden="true" />
                        <span>{repo.name}</span>
                      </>
                    );
                    return (
                      <li key={repo.directory ?? repo.url}>
                        {repo.directory !== undefined ? (
                          <div
                            className="repository-entry"
                            title={repo.directory}
                          >
                            {content}
                          </div>
                        ) : (
                          <a
                            className="repository-entry"
                            href={repo.url}
                            target="_blank"
                            rel="noreferrer"
                            title={repo.url}
                          >
                            {content}
                          </a>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="workspace-note">
                  {repositories
                    ? "Click + to add a code repo"
                    : storageError
                      ? "Code repos unavailable."
                      : "Loading code repos…"}
                </p>
              )}
            </li>
          );
        })}
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

function RepositoryDialog({
  node,
  onAdd,
  onClose,
}: {
  node: FleetNode;
  onAdd: (directory: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const directoryInput = useRef<HTMLInputElement>(null);
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    directoryInput.current?.focus();
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      onAdd(directory);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not add the code repo.",
      );
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
        <small>Directories are saved in this browser.</small>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <div className="settings-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Add code repo</Button>
        </div>
      </form>
    </dialog>
  );
}
