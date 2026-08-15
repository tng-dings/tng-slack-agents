export class RunnerError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthorizationError extends RunnerError {
  constructor(message = "You are not authorized to use this agent.") {
    super(message, "NOT_AUTHORIZED");
  }
}

export class LimitError extends RunnerError {
  constructor(message: string, code: string) {
    super(message, code);
  }
}

export class TimeoutError extends RunnerError {
  constructor(message: string) {
    super(message, "JOB_TIMEOUT");
  }
}

export class ShutdownError extends RunnerError {
  constructor() {
    super("The agent runner is shutting down.", "RUNNER_SHUTDOWN");
  }
}

export class OpenCodeError extends RunnerError {
  constructor(message: string, code = "OPENCODE_ERROR") {
    super(message, code);
  }
}

export class ClaudeCodeError extends RunnerError {
  constructor(message: string, code = "CLAUDE_CODE_ERROR") {
    super(message, code);
  }
}
