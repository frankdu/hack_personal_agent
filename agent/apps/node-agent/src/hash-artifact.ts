import { resolve } from "node:path";
import { artifactSha256 } from "./runtime.js";

const path = process.argv[2];
if (!path || process.argv.length !== 3)
  throw new Error(
    "Usage: npm run runtime:hash -w @agent/node-agent -- /absolute/model/path",
  );
console.info(await artifactSha256(resolve(path)));
