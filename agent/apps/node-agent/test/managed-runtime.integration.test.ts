import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { command } from "../src/probes.js";
import {
  DockerContainerRuntime,
  RuntimeSupervisor,
  parseRuntimeManifest,
} from "../src/runtime.js";

// A real child/container HTTP service, deliberately no model weights or hosted requests.
const script = `
const http = require('node:http');
let warmups = 0;
let probes = 0;
const server = http.createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.method === 'GET' && request.url === '/v1/models') {
    probes++;
    response.end(JSON.stringify({data: [{id: 'runtime-smoke-gemma'}]}));
  } else if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    let input = '';
    for await (const chunk of request) input += chunk;
    const body = JSON.parse(input);
    if (body.model !== 'runtime-smoke-gemma' || body.max_tokens !== 1 || body.stream !== false) {
      response.writeHead(400);
      return response.end(JSON.stringify({error: 'unexpected warmup request'}));
    }
    warmups++;
    response.end(JSON.stringify({choices: [{message: {role: 'assistant', content: 'OK'}}]}));
  } else if (request.method === 'GET' && request.url === '/__smoke') {
    response.end(JSON.stringify({pid: process.pid, warmups, probes}));
  } else { response.writeHead(404); response.end('{}'); }
});
server.listen(Number(process.argv[2]), process.argv[3]);
process.once('SIGTERM', () => server.close(() => process.exit(0)));
`;

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function eventually<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 10000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch {
      /* Startup or shutdown transient. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "Managed runtime did not reach expected state before deadline",
  );
}
async function stats(
  endpoint: string,
): Promise<{ pid: number; warmups: number; probes: number }> {
  const response = await fetch(new URL("/__smoke", endpoint), {
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function stopped(endpoint: string) {
  return eventually(async () => {
    try {
      await fetch(`${endpoint}/models`, { signal: AbortSignal.timeout(500) });
      return undefined;
    } catch {
      return true;
    }
  });
}
async function artifact() {
  const directory = await mkdtemp(join(tmpdir(), "managed-runtime-smoke-"));
  const path = join(directory, "runtime.cjs");
  await writeFile(path, script);
  return {
    directory,
    path,
    hash: createHash("sha256").update(script).digest("hex"),
  };
}

test(
  "native managed runtime launches a real process, warms, and stops its owned process",
  {
    skip:
      process.env.RUN_NATIVE_RUNTIME_TESTS !== "1"
        ? "Set RUN_NATIVE_RUNTIME_TESTS=1 to run native process smoke tests"
        : false,
    timeout: 30000,
  },
  async () => {
    const files = await artifact();
    const port = await unusedPort();
    const manifest = parseRuntimeManifest({
      kind: "native",
      profileId: "native-smoke",
      modelId: "runtime-smoke-gemma",
      endpoint: `http://127.0.0.1:${port}/v1`,
      requiredMemoryBytes: 16 * 1024 ** 2,
      startupTimeoutMs: 5000,
      probeIntervalMs: 300000,
      maxRestarts: 0,
      native: {
        executable: process.execPath,
        args: [files.path, String(port), "127.0.0.1"],
        artifactPath: files.path,
        artifactSha256: files.hash,
      },
    });
    const runtime = new RuntimeSupervisor(
      manifest,
      randomUUID(),
      files.directory,
    );
    try {
      await runtime.start();
      assert.equal(runtime.profile().state, "ready");
      const observed = await stats(manifest.endpoint);
      assert.notEqual(observed.pid, process.pid);
      assert.equal(observed.warmups, 1);
      assert.ok(observed.probes >= 1);
      await runtime.close();
      assert.equal(runtime.profile().state, "stopped");
      await stopped(manifest.endpoint);
      assert.throws(
        () => process.kill(observed.pid, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      );
    } finally {
      await runtime.close();
      await rm(files.directory, { recursive: true, force: true });
    }
  },
);

test(
  "Docker managed runtime warms, adopts after journal loss, and removes only its own container",
  {
    skip:
      process.env.RUN_DOCKER_RUNTIME_TESTS !== "1"
        ? "Set RUN_DOCKER_RUNTIME_TESTS=1 with an already provisioned RUNTIME_SMOKE_IMAGE digest"
        : false,
    timeout: 60000,
  },
  async () => {
    const image = process.env.RUNTIME_SMOKE_IMAGE;
    assert.ok(
      image && /^[a-zA-Z0-9/._:-]+@sha256:[a-f0-9]{64}$/.test(image),
      "RUNTIME_SMOKE_IMAGE must be an approved local Node image pinned by digest",
    );
    // Inspection, not pulling: missing images must be provisioned explicitly by the operator.
    await command("docker", ["image", "inspect", image]);
    const files = await artifact();
    const port = await unusedPort();
    const nodeId = randomUUID();
    const sentinelName = `curilo_agent-smoke-sentinel-${nodeId}`;
    const manifest = parseRuntimeManifest({
      kind: "docker",
      profileId: "docker-smoke",
      modelId: "runtime-smoke-gemma",
      endpoint: `http://127.0.0.1:${port}/v1`,
      requiredMemoryBytes: 16 * 1024 ** 2,
      startupTimeoutMs: 10000,
      probeIntervalMs: 300000,
      maxRestarts: 0,
      docker: {
        image,
        command: ["node", "/smoke/runtime.cjs", "8080", "0.0.0.0"],
        containerPort: 8080,
        artifactPath: files.path,
        artifactSha256: files.hash,
        modelMountPath: "/smoke/runtime.cjs",
        memoryBytes: 128 * 1024 ** 2,
        cpus: 1,
      },
    });
    const runtimeName = `curilo_agent-${nodeId}-${manifest.profileId}`;
    const launcher = new DockerContainerRuntime(
      manifest,
      nodeId,
      files.directory,
    );
    const adopted = new RuntimeSupervisor(manifest, nodeId, files.directory);
    let sentinelId: string | undefined;
    let runtimeId: string | undefined;
    async function inspect(name: string): Promise<any> {
      return JSON.parse(await command("docker", ["inspect", name]))[0];
    }
    async function cleanOwned(name: string, ownerLabel: string) {
      let item: any;
      try {
        item = await inspect(name);
      } catch {
        return;
      }
      assert.equal(
        item.Config.Labels[ownerLabel],
        nodeId,
        "Cleanup refuses a container not owned by this test",
      );
      await command("docker", ["rm", "-f", item.Id]);
    }
    try {
      sentinelId = (
        await command("docker", [
          "run",
          "-d",
          "--pull=never",
          "--name",
          sentinelName,
          "--label",
          `curilo_agent.smoke-run=${nodeId}`,
          "--memory",
          String(128 * 1024 ** 2),
          "--cpus",
          "1",
          image,
          "node",
          "-e",
          "setInterval(() => {}, 1000)",
        ])
      ).trim();
      await launcher.start();
      await eventually(async () => {
        const state = await stats(manifest.endpoint);
        return state.probes >= 0 ? state : undefined;
      });
      const journalPath = join(
        files.directory,
        `runtime-${manifest.profileId}.json`,
      );
      runtimeId = JSON.parse(await readFile(journalPath, "utf8")).containerId;
      assert.ok(runtimeId);
      const initial = await inspect(runtimeId);
      assert.equal(initial.State.Running, true);
      assert.equal(
        initial.HostConfig.PortBindings["8080/tcp"][0].HostIp,
        "127.0.0.1",
      );
      assert.equal(
        initial.Mounts.find(
          (mount: any) => mount.Destination === "/smoke/runtime.cjs",
        ).RW,
        false,
      );
      // Simulate the previous node process dying before its runtime record was durable.
      // No running supervisor from that process remains: launcher is only the lifecycle adapter.
      await rm(journalPath);
      await adopted.start();
      assert.equal(adopted.profile().state, "ready");
      assert.equal(
        JSON.parse(await readFile(journalPath, "utf8")).containerId,
        runtimeId,
      );
      const warmed = await stats(manifest.endpoint);
      assert.equal(warmed.warmups, 1);
      assert.ok(warmed.probes >= 1);
      await adopted.close();
      await stopped(manifest.endpoint);
      const remaining = await command("docker", [
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `name=^/${runtimeName}$`,
        "--format",
        "{{.ID}}",
      ]);
      assert.equal(remaining.trim(), "");
      assert.equal(
        (await inspect(sentinelId)).State.Running,
        true,
        "Stopping runtime must leave the unrelated sentinel running",
      );
    } finally {
      await adopted.close().catch(() => {});
      // Deterministic names cover setup failures before an ID is returned, without global cleanup.
      await cleanOwned(runtimeId ?? runtimeName, "curilo_agent.node");
      await cleanOwned(sentinelId ?? sentinelName, "curilo_agent.smoke-run");
      await rm(files.directory, { recursive: true, force: true });
    }
  },
);
