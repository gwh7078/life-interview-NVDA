import { execFile } from 'node:child_process';

export interface CommandRunResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    timeoutMs: number,
    stdin?: string,
    signal?: AbortSignal,
  ): Promise<CommandRunResult>;
}

export class CommandExecutionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'AGENT_RUNTIME_TIMEOUT'
      | 'AGENT_RUNTIME_EXEC_FAILED'
      | 'AGENT_RUNTIME_CANCELLED',
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'CommandExecutionError';
  }
}

export class ExecFileCommandRunner implements CommandRunner {
  run(
    command: string,
    args: string[],
    timeoutMs: number,
    stdin?: string,
    signal?: AbortSignal,
  ): Promise<CommandRunResult> {
    if (signal?.aborted) {
      return Promise.reject(new CommandExecutionError(
        'NemoClaw/OpenClaw execution was cancelled.',
        'AGENT_RUNTIME_CANCELLED',
      ));
    }

    return new Promise((resolve, reject) => {
      let cancelled = false;
      const child = execFile(command, args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      }, (error, stdout, stderr) => {
        signal?.removeEventListener('abort', onAbort);
        if (error) {
          const killed = Boolean((error as NodeJS.ErrnoException & { killed?: boolean }).killed);
          reject(new CommandExecutionError(
            cancelled
              ? 'NemoClaw/OpenClaw execution was cancelled.'
              : killed
                ? 'NemoClaw/OpenClaw execution timed out.'
                : 'NemoClaw/OpenClaw execution failed.',
            cancelled
              ? 'AGENT_RUNTIME_CANCELLED'
              : killed
                ? 'AGENT_RUNTIME_TIMEOUT'
                : 'AGENT_RUNTIME_EXEC_FAILED',
            stderr,
          ));
          return;
        }
        resolve({ stdout, stderr });
      });

      const onAbort = () => {
        cancelled = true;
        child.kill('SIGTERM');
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();

      if (stdin !== undefined) child.stdin?.end(stdin, 'utf8');
    });
  }
}
