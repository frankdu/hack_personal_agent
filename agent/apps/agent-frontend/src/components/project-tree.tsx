import { useState, type KeyboardEvent } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { projectTreeResponseSchema, type Project } from "@agent/contracts";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  Link,
} from "lucide-react";
import { apiRequest, errorText, type Connection } from "../lib/api";

type TreeProps = {
  connection: Connection;
  nodeId: string;
  project: Project;
  online: boolean;
};

// Keep focus navigation inside this project's visible tree items.
function navigateTree(event: KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement;
  const tree = target.closest('[role="tree"]');
  if (!tree || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
    return;
  const items = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const index = items.indexOf(target);
  if (index < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : Math.max(
            0,
            Math.min(
              items.length - 1,
              index + (event.key === "ArrowDown" ? 1 : -1),
            ),
          );
  items[next]?.focus();
}

export function ProjectTree(props: TreeProps) {
  return <Directory {...props} path="." name={props.project.name} root />;
}

function Directory(
  props: TreeProps & { path: string; name: string; root?: boolean },
) {
  const [expanded, setExpanded] = useState(
    Boolean(props.root && props.project.source === "chat_sessions"),
  );
  return (
    <li role="none">
      <button
        type="button"
        role="treeitem"
        aria-expanded={expanded}
        className={`project-tree-entry ${props.root ? "project-root" : ""}`}
        title={props.root ? props.project.directory : props.path}
        onKeyDown={(event) => {
          navigateTree(event);
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setExpanded(true);
          }
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            setExpanded(false);
          }
        }}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
        <span>{props.name}</span>
      </button>
      {expanded && <DirectoryContents {...props} />}
    </li>
  );
}

function DirectoryContents(props: TreeProps & { path: string }) {
  const listing = useInfiniteQuery({
    queryKey: [
      "project-tree",
      props.connection.id,
      props.nodeId,
      props.project.id,
      props.path,
    ],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({
        path: props.path,
        offset: String(pageParam),
      });
      return apiRequest(
        props.connection,
        `/v1/nodes/${props.nodeId}/projects/${props.project.id}/tree?${query}`,
        projectTreeResponseSchema,
        { signal },
      );
    },
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    enabled: props.online,
    refetchInterval: 3000,
    retry: false,
  });
  const entries = [
    ...new Map(
      listing.data?.pages
        .flatMap((page) => page.entries)
        .map((entry) => [entry.path, entry]) ?? [],
    ).values(),
  ].sort(
    (a, b) =>
      Number(b.kind === "directory") - Number(a.kind === "directory") ||
      a.name.localeCompare(b.name),
  );
  return (
    <ul role="group" className="project-tree-children">
      {listing.isPending && (
        <li role="none" className="workspace-note">
          {props.online ? "Loading…" : "Node offline"}
        </li>
      )}
      {listing.error && (
        <li role="none" className="workspace-list-error">
          {errorText(listing.error)}{" "}
          <button onClick={() => void listing.refetch()}>Retry</button>
        </li>
      )}
      {listing.data && entries.length === 0 && (
        <li role="none" className="workspace-note">
          Empty directory
        </li>
      )}
      {entries.map((entry) =>
        entry.kind === "directory" ? (
          <Directory
            {...props}
            root={false}
            key={entry.path}
            name={entry.name}
            path={entry.path}
          />
        ) : (
          <li role="none" key={entry.path}>
            <span
              role="treeitem"
              tabIndex={0}
              onKeyDown={navigateTree}
              className="project-tree-entry project-tree-file"
              title={
                entry.kind === "symlink"
                  ? `${entry.name} (symbolic link)`
                  : entry.name
              }
            >
              {entry.kind === "symlink" ? (
                <Link size={14} />
              ) : (
                <File size={14} />
              )}
              <span>{entry.name}</span>
            </span>
          </li>
        ),
      )}
      {listing.hasNextPage && (
        <li role="none">
          <button
            className="project-tree-more"
            disabled={listing.isFetchingNextPage}
            onClick={() => void listing.fetchNextPage()}
          >
            {listing.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </li>
      )}
    </ul>
  );
}
