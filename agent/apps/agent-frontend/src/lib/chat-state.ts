import type {
  Conversation,
  EnabledTool,
  FleetNode,
  Task,
  TaskStatus,
} from "@agent/contracts";

export function isTaskActive(status: TaskStatus): boolean {
  return status === "queued" || status === "running";
}

export function readyModelIds(nodes: FleetNode[]): string[] {
  return [
    ...new Set(
      nodes
        .filter((node) => node.status === "online")
        .flatMap((node) =>
          node.profiles
            .filter((profile) => profile.state === "ready")
            .map((profile) => profile.modelId),
        ),
    ),
  ].sort();
}

export function eligibleNode(
  node: FleetNode,
  workspaceId: string,
  tools: EnabledTool[],
  modelId?: string,
): boolean {
  return (
    node.status === "online" &&
    node.workspaceIds.includes(workspaceId) &&
    tools.every((tool) => node.enabledTools.includes(tool)) &&
    node.profiles.some(
      (profile) =>
        profile.state === "ready" &&
        (!modelId || profile.modelId === modelId) &&
        node.activeAttempts.length < profile.concurrency,
    )
  );
}

/** Task output is cumulative; never concatenate polling snapshots. */
export function pendingAssistantOutput(
  conversation: Conversation | undefined,
  task: Task | undefined,
): string | null {
  if (
    !task ||
    (conversation &&
      conversation.activeTaskId !== task.id &&
      ["succeeded", "failed", "cancelled"].includes(task.status)) ||
    conversation?.messages.some(
      (message) => message.role === "assistant" && message.taskId === task.id,
    )
  )
    return null;
  return task.output;
}

export function selectedNodeProblem(
  nodes: FleetNode[],
  nodeId: string,
  workspaceId: string,
  tools: EnabledTool[],
  modelId?: string,
): string | null {
  const node = nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node)
    return "The pinned node is no longer registered. Choose another node explicitly or switch to auto routing.";
  if (node.status !== "online")
    return `The pinned node is ${node.status}. It will not be replaced automatically.`;
  if (!node.workspaceIds.includes(workspaceId))
    return "The pinned node does not expose this workspace.";
  if (tools.some((tool) => !node.enabledTools.includes(tool)))
    return "The pinned node does not enable every requested tool.";
  if (!node.profiles.some((profile) => profile.state === "ready"))
    return "The pinned node has no ready model. Wait for it to warm up or choose another node.";
  if (
    modelId &&
    !node.profiles.some(
      (profile) => profile.state === "ready" && profile.modelId === modelId,
    )
  )
    return `The pinned node does not have ${modelId} active and ready. Activate it on this node, choose another model, or use Auto model.`;
  if (!eligibleNode(node, workspaceId, tools, modelId))
    return "The pinned node is busy. Wait for its active or unresolved tasks to finish.";
  return null;
}
