import * as yaml from 'js-yaml';
import * as path from 'node:path';

import { bracketIpv6HostIp } from './compose';
import { ServiceError } from './errors';
import type { Composition, Dict } from './types';

// js-yaml only quotes a key when its own resolvers find it ambiguous, and
// those reject underscores, so a key like `1_0` is written bare. compose-go's
// yaml.v3 strips the underscores and reads a number, then fails on a non-string
// key. Telling js-yaml that anything starting like a number is a scalar type
// of its own makes it quote such keys. Quoting a key it did not need to is
// harmless, so the test is deliberately broad.
const looksNumeric = new yaml.Type('tag:balena.io,2026:looks-numeric', {
	kind: 'scalar',
	resolve: (text: string) => /^[+-]?[.0-9]/.test(text),
});
const schema = yaml.DEFAULT_SCHEMA.extend({ implicit: [looksNumeric] });

/**
 * Write a parsed composition back out as a self-contained docker-compose file.
 *
 * This is how a compose file travels from the CLI to the builder. The CLI
 * parses with `hostEnvironment: true`, so `${VAR}` references, valueless
 * `environment` entries, `env_file`, `label_file`, `include` and `extends.file`
 * are all resolved against the user's machine. The builder then re-parses the
 * output with `skipInterpolation: true` and the defaults, which read nothing
 * outside the file. What the user's shell resolved stays resolved, and the
 * builder never has to find a secondary file or share its own environment.
 *
 * Round-trip property, checked in test/serialize.spec.ts for every fixture:
 *
 *     parse(serialize(c), { skipInterpolation: true })  deep-equals  c
 *
 * where `c = parse(file, { hostEnvironment: true })`. Interpolation has to be
 * off on the second parse, since a literal `$` that survived the first one is
 * meant to stay literal.
 *
 * @param composition - A composition returned by `parse()`
 * @returns YAML text for a docker-compose.yml
 */
export function serialize(composition: Composition): string {
	const output: Dict<any> = structuredClone(composition);

	for (const [serviceName, service] of Object.entries<Dict<any>>(
		output.services ?? {},
	)) {
		// `parse()` already folded these into `environment` and `labels`, and
		// applied `extends`. Emitting them would make the builder reject the
		// file as still referencing secondary files, so make sure they are gone
		// rather than trusting that they were never set.
		delete service.env_file;
		delete service.label_file;
		delete service.extends;

		// `build.tags` is derived from `service.image` by `parse()` and is denied
		// as input, so drop it and let the second parse derive it again.
		if (service.build != null) {
			delete service.build.tags;
			if (typeof service.build.context === 'string') {
				service.build.context = toPosixBuildContext(
					service.build.context,
					serviceName,
				);
			}
		}

		if (Array.isArray(service.ports)) {
			service.ports = service.ports.map(bracketIpv6HostIp);
		}
	}

	return yaml.dump(output, {
		schema,
		// Repeated objects come out inline rather than as anchors and aliases,
		// which keeps the file readable in a build log or a release.
		noRefs: true,
		// Never wrap. A folded long string is a different string to a parser
		// that cares about whitespace, such as a command argument.
		lineWidth: -1,
		// Deterministic output, so the same composition always hashes the same.
		sortKeys: true,
		// `undefined` is a JavaScript artefact with no YAML spelling. A property
		// set to it is left out, and an array element becomes `null`, neither of
		// which parse() ever produces. `null` itself is kept, since it is
		// meaningful to compose-go (an empty network reference, an unset build
		// arg).
		skipInvalid: true,
		// Quote every string value, so that `1_000` or `0x_1`, which js-yaml
		// would leave bare and yaml.v3 would read as a number, come back as the
		// same string. Keys are handled by the schema above.
		forceQuotes: true,
	});
}

// On Windows, parse() gives `services\api`, or `D:\api` for a context on
// another drive. The builder needs a relative path with `/` separators.
function toPosixBuildContext(context: string, serviceName: string): string {
	const posix = context.replaceAll('\\', '/');
	if (path.posix.isAbsolute(posix) || path.win32.isAbsolute(posix)) {
		throw new ServiceError(
			'service.build.context must be relative to the compose file',
			serviceName,
		);
	}
	return posix;
}
