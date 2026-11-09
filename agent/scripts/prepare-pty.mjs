import { createRequire } from "node:module";
import { chmod, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

// node-pty 1.1.0 ships the macOS helper without its executable bit.
// Repair the installed package during npm ci, before a terminal can be opened.
if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  for (const path of [
    join(
      root,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    ),
    join(root, "build", "Release", "spawn-helper"),
  ]) {
    try {
      const info = await stat(path);
      await chmod(path, info.mode | 0o111);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
