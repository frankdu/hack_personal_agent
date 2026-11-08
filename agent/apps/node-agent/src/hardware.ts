import { arch, availableParallelism, cpus, freemem, platform, totalmem } from 'node:os';
import { readFile } from 'node:fs/promises';
import type { Hardware } from '@agent/contracts';
import { command, type Command } from './probes.js';

export async function inspectHardware(run: Command = command): Promise<Hardware> {
  const hardware: Hardware = {
    platform: platform(), arch: arch(), cpuModel: cpus()[0]?.model ?? 'unknown',
    cpuCores: Math.max(1, availableParallelism()), memoryBytes: totalmem(), availableMemoryBytes: freemem(),
    unifiedMemory: platform() === 'darwin' && arch() === 'arm64', gpus: [],
    docker: { available: false, scope: 'unknown' },
  };
  const probes: Promise<void>[] = [];
  if (platform() === 'darwin') probes.push((async () => {
    try {
      const data = JSON.parse(await run('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json']));
      for (const device of data.SPDisplaysDataType ?? []) hardware.gpus.push({ name: String(device.sppci_model ?? 'Apple GPU'), vendor: hardware.unifiedMemory ? 'apple' : 'other', memoryBytes: null });
    } catch { /* Unavailable probe does not advertise a GPU. */ }
  })());
  if (platform() === 'linux') {
    probes.push((async () => {
      try {
        const output = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
        for (const row of output.trim().split('\n').filter(Boolean)) {
          const separator = row.lastIndexOf(',');
          const mib = Number(row.slice(separator + 1).trim());
          hardware.gpus.push({ name: row.slice(0, separator).trim(), vendor: 'nvidia', memoryBytes: Number.isFinite(mib) ? mib * 1048576 : null });
        }
      } catch { /* CUDA execution is not assumed solely from OS. */ }
      try {
        const [limitText, usedText] = await Promise.all([readFile('/sys/fs/cgroup/memory.max', 'utf8'), readFile('/sys/fs/cgroup/memory.current', 'utf8')]);
        const limit = Number(limitText.trim()); const used = Number(usedText.trim());
        if (Number.isFinite(limit) && limit > 0) {
          hardware.memoryBytes = Math.min(hardware.memoryBytes, limit);
          hardware.availableMemoryBytes = Math.min(hardware.availableMemoryBytes, Math.max(0, limit - used));
        }
      } catch { /* Host without cgroup v2: OS measurements remain. */ }
    })());
  }
  probes.push((async () => {
    try {
      const info = JSON.parse(await run('docker', ['info', '--format', '{{json .}}']));
      hardware.docker = { available: true, scope: /docker desktop/i.test(String(info.OperatingSystem)) ? 'vm' : platform() === 'linux' ? 'host' : 'unknown' };
    } catch { /* Docker is optional. */ }
  })());
  await Promise.all(probes);
  return hardware;
}
