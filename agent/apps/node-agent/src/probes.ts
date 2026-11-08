import { execFile } from "node:child_process";
export type Command = (file: string, args: string[]) => Promise<string>;
export const command: Command = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 5000, maxBuffer: 512 * 1024, encoding: "utf8", shell: false },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
