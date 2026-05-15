export class OdooError extends Error {
  constructor(
    public readonly errorType: string,
    message: string,
    public readonly model?: string,
    public readonly method?: string,
    public readonly traceback?: string,
  ) {
    super(message);
    this.name = 'OdooError';
  }
}

export class OdooAuthError extends OdooError {
  constructor(message: string, traceback?: string) {
    super('OdooAuthError', message, undefined, undefined, traceback);
    this.name = 'OdooAuthError';
  }
}

export class OdooUserError extends OdooError {
  constructor(message: string, model?: string, method?: string, traceback?: string) {
    super('UserError', message, model, method, traceback);
    this.name = 'OdooUserError';
  }
}

export class OdooValidationError extends OdooError {
  constructor(message: string, model?: string, method?: string, traceback?: string) {
    super('ValidationError', message, model, method, traceback);
    this.name = 'OdooValidationError';
  }
}

export class OdooAccessError extends OdooError {
  constructor(message: string, model?: string, method?: string, traceback?: string) {
    super('AccessError', message, model, method, traceback);
    this.name = 'OdooAccessError';
  }
}

export class OdooMissingError extends OdooError {
  constructor(message: string, model?: string, method?: string, traceback?: string) {
    super('MissingError', message, model, method, traceback);
    this.name = 'OdooMissingError';
  }
}

export class OdooConnectionError extends OdooError {
  constructor(message: string) {
    super('ConnectionError', message);
    this.name = 'OdooConnectionError';
  }
}
