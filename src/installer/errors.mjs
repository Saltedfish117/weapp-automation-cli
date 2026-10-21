export class SetupError extends Error {
  constructor(message, { code = 'setup-failed', exitCode = 1, data = null, cause } = {}) {
    super(message, { cause });
    this.name = 'SetupError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

export function configuration(message, code = 'bad-arguments', data = null) {
  return new SetupError(message, { code, exitCode: 4, data });
}
