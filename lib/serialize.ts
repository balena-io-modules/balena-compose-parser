import * as yaml from 'js-yaml';

import type { Composition, Dict } from './types';

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

	for (const service of Object.values<Dict<any>>(output.services ?? {})) {
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
		}

		if (Array.isArray(service.ports)) {
			service.ports = service.ports.map(bracketIpv6HostIp);
		}
	}

	return yaml.dump(output, {
		// Repeated objects come out inline rather than as anchors and aliases,
		// which keeps the file readable in a build log or a release.
		noRefs: true,
		// Never wrap. A folded long string is a different string to a parser
		// that cares about whitespace, such as a command argument.
		lineWidth: -1,
		// Deterministic output, so the same composition always hashes the same.
		sortKeys: true,
		// `undefined` is a JavaScript artefact with no YAML spelling, so leave it
		// out. `null` is kept, since it is meaningful to compose-go (an empty
		// network reference, an unset build arg).
		skipInvalid: true,
		// js-yaml leaves `1_000` or `0x_1` bare because its number resolvers
		// reject underscores, but compose-go's yaml.v3 strips them and reads a
		// number. Quote every string so it comes back as the same string.
		forceQuotes: true,
	});
}

// `parse()` emits an IPv6 host address unbracketed (`::1:6001:6001`), which the
// Supervisor accepts and compose-go rejects. The last two segments are always
// the host port and container port, so anything before them is the address.
function bracketIpv6HostIp(port: unknown): unknown {
	if (typeof port !== 'string') {
		return port;
	}
	const match = /^(.+):([^:]*):([^:]+)$/.exec(port);
	if (match == null || !match[1].includes(':') || match[1].startsWith('[')) {
		return port;
	}
	return `[${match[1]}]:${match[2]}:${match[3]}`;
}
