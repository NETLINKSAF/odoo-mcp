/**
 * Base class for every error this library throws. Carries the original Odoo
 * `errorType` discriminator plus optional `model` / `method` / `traceback`
 * context. `traceback` may contain Odoo's Python stack — callers that surface
 * errors to users should suppress it unless explicitly opted in.
 */
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

/**
 * Thrown when authentication is rejected (`odoo.exceptions.AccessDenied` from
 * Odoo, or when extracting the session response yields invalid/missing fields).
 * `model` and `method` are always undefined because auth happens at the
 * session endpoint, not against a specific model.
 */
export class OdooAuthError extends OdooError {
  constructor(message: string, traceback?: string) {
    super('OdooAuthError', message, undefined, undefined, traceback);
    this.name = 'OdooAuthError';
  }
}

/**
 * Thrown when Odoo raises a user-facing validation failure
 * (`odoo.exceptions.UserError`). Typically surfaces business-rule violations
 * intended to be shown to the end user — pass the `message` through verbatim.
 */
export class OdooUserError extends OdooError {
  constructor(message: string, model?: string, method?: string, traceback?: string) {
    super('UserError', message, model, method, traceback);
    this.name = 'OdooUserError';
  }
}

/**
 * Thrown when Odoo rejects a write/create due to schema or constraint
 * validation (`odoo.exceptions.ValidationError`). Distinct from UserError in
 * that the failure is at the data layer, not business logic.
 */
export class OdooValidationError extends OdooError {
  constructor(message: string, model?: string, method?: string, traceback?: string) {
    super('ValidationError', message, model, method, traceback);
    this.name = 'OdooValidationError';
  }
}

/**
 * Thrown when the authenticated user lacks permission on a record/model
 * (`odoo.exceptions.AccessError`). Different from `OdooAuthError`, which is
 * about session establishment; this is about record-rule denial post-auth.
 */
export class OdooAccessError extends OdooError {
  constructor(message: string, model?: string, method?: string, traceback?: string) {
    super('AccessError', message, model, method, traceback);
    this.name = 'OdooAccessError';
  }
}

/**
 * Thrown when an operation targets a record that no longer exists or was
 * never accessible (`odoo.exceptions.MissingError`). Common cause: a stale
 * ID after another session deleted the record.
 */
export class OdooMissingError extends OdooError {
  constructor(message: string, model?: string, method?: string, traceback?: string) {
    super('MissingError', message, model, method, traceback);
    this.name = 'OdooMissingError';
  }
}

/**
 * Thrown for transport-layer failures: connection refused, DNS, TLS, or
 * request timeout. Carries no traceback because the failure occurred before
 * Odoo returned a response.
 */
export class OdooConnectionError extends OdooError {
  constructor(message: string) {
    super('ConnectionError', message);
    this.name = 'OdooConnectionError';
  }
}
