export type WorkspaceRepository = {
  nodeId: string;
  name: string;
} & ({ directory: string; url?: never } | { url: string; directory?: never });

export function repositoryDetails(input: string) {
  const directory = input.trim();
  if (
    !directory ||
    /[\0\r\n]/.test(directory) ||
    /^[a-z][a-z\d+.-]*:\/\//i.test(directory)
  ) {
    throw new Error("Enter a code directory path on this node.");
  }
  return {
    directory,
    name:
      directory
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .at(-1) || directory,
  };
}

export function parseRepositories(value: string | null): WorkspaceRepository[] {
  if (value === null) return [];
  const data: unknown = JSON.parse(value);
  if (!Array.isArray(data)) throw new Error("Invalid saved repositories.");
  return data.map((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      !("nodeId" in item) ||
      typeof item.nodeId !== "string"
    ) {
      throw new Error("Invalid saved repository.");
    }
    if ("directory" in item && typeof item.directory === "string") {
      return { nodeId: item.nodeId, ...repositoryDetails(item.directory) };
    }
    // Keep previously saved repository links available alongside directories.
    if (
      "url" in item &&
      typeof item.url === "string" &&
      "name" in item &&
      typeof item.name === "string"
    ) {
      const url = new URL(item.url);
      if (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      ) {
        return { nodeId: item.nodeId, url: url.toString(), name: item.name };
      }
    }
    throw new Error("Invalid saved repository.");
  });
}
