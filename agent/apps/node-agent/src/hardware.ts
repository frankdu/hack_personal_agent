import { arch, availableParallelism, cpus, freemem, platform, release, totalmem } from "node:os";

/** Baseline OS observations, not a claim about model capacity or GPU availability. */
export function inspectHardware() {
  const processors = cpus();
  return {
    platform: platform(),
    architecture: arch(),
    osRelease: release(),
    cpu: {
      model: processors[0]?.model ?? "unknown",
      logicalCores: processors.length,
      availableParallelism: availableParallelism(),
    },
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    gpu: { detection: "not_implemented" as const, devices: [] },
    observedAt: new Date().toISOString(),
  };
}
