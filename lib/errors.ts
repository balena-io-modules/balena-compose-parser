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
