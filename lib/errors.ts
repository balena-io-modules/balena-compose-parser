import { TypedError } from 'typed-error';

export enum ErrorLevel {
	ERROR = 'error',
	FATAL = 'fatal',
	WARN = 'warn',
	INFO = 'info',
	DEBUG = 'debug',
}

export class ComposeError extends TypedError {
	constructor(
		public message: string,
		// The error level, e.g. "error", "fatal", "panic"
		public level = ErrorLevel.ERROR,
		public name = 'ComposeError',
	) {
		super(message);
	}
}

export class ValidationError extends ComposeError {
	constructor(public message: string) {
		super(message, ErrorLevel.ERROR, 'ValidationError');
	}
}

/**
 * The compose file names a file the parser was not allowed to read. `field` is
 * the dotted path at fault, such as `services.app.env_file` or `include`.
 * Extends ValidationError, which is how it was reported before it had a class.
 */
export class SecondaryFileError extends ValidationError {
	constructor(
		public message: string,
		public field: string,
	) {
		super(message);
		this.name = 'SecondaryFileError';
	}
}

export class ServiceError extends ComposeError {
	constructor(
		public message: string,
		public serviceName: string,
	) {
		super(message, ErrorLevel.ERROR, 'ServiceError');
	}
}

export class ArgumentError extends ComposeError {
	constructor(public message: string) {
		super(message, ErrorLevel.ERROR, 'ArgumentError');
	}
}

/** compose-go could not read or parse a compose file, or marshal the result. */
export class ParseError extends ComposeError {
	constructor(public message: string) {
		super(message, ErrorLevel.ERROR, 'ParseError');
	}
}

/** The binary gave up on the parse, which is its own limit and not the file's fault. */
export class TimeoutError extends ComposeError {
	constructor(public message: string) {
		super(message, ErrorLevel.ERROR, 'TimeoutError');
	}
}

/** compose-go rejected the project options before it looked at the file. */
export class ConfigError extends ComposeError {
	constructor(public message: string) {
		super(message, ErrorLevel.ERROR, 'ConfigError');
	}
}
