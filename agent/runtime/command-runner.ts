import { execFile } from 'node:child_process';

export interface CommandRunResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<CommandRunResult>;
}

export class CommandExecutionError extends Error {
  constructor(
    message: string,
    readonly code: 'AGENT_RUNTIME_TIMEOUT' | 'AGENT_RUNTIME_EXEC_FAILED',
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'CommandExecutionError';
  }
}

export class ExecFileCommandRunner implements CommandRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<CommandRunResult> {
    return new Promise((resolve, reject) => {
      execFile(command, args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      }, (error, stdout, stderr) => {
        if (error) {
          const killed = Boolean((error as NodeJS.ErrnoException & { killed?: boolean }).killed);
          reject(new CommandExecutionError(
            killed ? 'NemoClaw/OpenClaw execution timed out.' : 'NemoClaw/OpenClaw execution failed.',
            killed ? 'AGENT_RUNTIME_TIMEOUT' : 'AGENT_RUNTIME_EXEC_FAILED',
            stderr,
          ));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}
