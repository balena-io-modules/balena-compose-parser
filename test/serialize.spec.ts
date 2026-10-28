import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';

import { parse, serialize } from '../lib/index';
import type { Composition, ParseOptions } from '../lib/index';

/**
 * Write the serialized composition to a fresh directory and parse it the way
 * the builder does: no host environment, so nothing outside the file is read,
 * and interpolation off, so a literal `$` stays literal.
 */
async function reparse(
	composition: Composition,
	options: ParseOptions = { skipInterpolation: true },
): Promise<Composition> {
	const dir = await mkdtemp(join(tmpdir(), 'compose-parser-serialize-'));
	try {
		const file = join(dir, 'docker-compose.yml');
		await writeFile(file, serialize(composition), 'utf8');
		return await parse(file, options);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe('serialize', () => {
	let warnStub: SinonStub;

	beforeEach(() => {
		warnStub = stub(console, 'warn');
	});

	afterEach(() => {
		warnStub.restore();
	});

	it('produces docker-compose YAML', () => {
		const out = serialize({
			services: { main: { image: 'alpine:latest' } },
		});
		expect(out).to.equal("services:\n  main:\n    image: 'alpine:latest'\n");
	});

	it('brackets an IPv6 host address, which parse() emits bare for the Supervisor', () => {
		const out = serialize({
			services: {
				main: {
					image: 'alpine:latest',
					ports: ['::1:6001:6001', '::1::6002', '127.0.0.1::80', '8080:80/udp'],
				},
			},
		});
		expect(out).to.include("'[::1]:6001:6001'");
		expect(out).to.include("'[::1]::6002'");
		expect(out).to.include("'127.0.0.1::80'");
		expect(out).to.include("'8080:80/udp'");
	});

	it('emits repeated objects inline rather than as anchors', () => {
		const shared = { 'io.balena.x': '1' };
		const out = serialize({
			services: {
				a: { image: 'alpine:latest', labels: shared },
				b: { image: 'alpine:latest', labels: shared },
			},
		});
		expect(out).to.not.match(/[&*]\w+/);
	});

	it('does not emit build.tags, which parse() derives from the image', () => {
		const out = serialize({
			services: {
				main: {
					image: 'myimage:latest',
					build: { context: '.', tags: ['myimage:latest'] },
				},
			},
		});
		expect(out).to.not.include('tags');
	});

	it('does not emit secondary file references even if handed some', () => {
		const out = serialize({
			services: {
				main: {
					image: 'alpine:latest',
					env_file: ['.env'],
					label_file: ['app.labels'],
					extends: { file: 'other.yml', service: 'base' },
				} as any,
			},
		});
		expect(out).to.not.match(/env_file|label_file|extends/);
	});

	it('does not mutate its argument', () => {
		const composition: Composition = {
			services: {
				main: {
					image: 'myimage:latest',
					build: { context: '.', tags: ['myimage:latest'] },
				},
			},
		};
		const before = structuredClone(composition);
		serialize(composition);
		expect(composition).to.deep.equal(before);
	});

	describe('parse → serialize → parse', () => {
		// Everything parse() normalizes has to come out the same the second time
		// round, or a release built from the folded file differs from what the
		// CLI showed the user. Each fixture here exercises a different part of
		// normalizeService / normalizeNetwork / normalizeVolume.
		const fixtures = [
			'test/fixtures/simple.yml',
			'test/fixtures/complex.yml',
			'test/fixtures/contracts/valid.yml',
			'test/fixtures/compose/extensions.yml',
			'test/fixtures/compose/fragments.yml',
			'test/fixtures/compose/include/main.yml',
			'test/fixtures/compose/build/context.yml',
			'test/fixtures/compose/build/supported_fields.yml',
			'test/fixtures/compose/networks/implicit_default.yml',
			'test/fixtures/compose/networks/implicit_default_configured.yml',
			'test/fixtures/compose/networks/implicit_default_multi_network.yml',
			'test/fixtures/compose/networks/implicit_default_reference_config.yml',
			'test/fixtures/compose/networks/supported_fields.yml',
			'test/fixtures/compose/services/container_name.yml',
			'test/fixtures/compose/services/env_file.yml',
			'test/fixtures/compose/services/extends.yml',
			'test/fixtures/compose/services/extends_2.yml',
			'test/fixtures/compose/services/full.yml',
			'test/fixtures/compose/services/image_build.yml',
			'test/fixtures/compose/services/ipc_host.yml',
			'test/fixtures/compose/services/label_file.yml',
			'test/fixtures/compose/services/network_mode.yml',
			'test/fixtures/compose/services/networks.yml',
			'test/fixtures/compose/services/newly_supported.yml',
			'test/fixtures/compose/services/no_newly_supported.yml',
			'test/fixtures/compose/services/null_env.yml',
			'test/fixtures/compose/services/pid.yml',
			'test/fixtures/compose/services/ports.yml',
			'test/fixtures/compose/services/ports_ignored.yml',
			'test/fixtures/compose/services/profiles.yml',
			'test/fixtures/compose/services/restart.yml',
			'test/fixtures/compose/services/security_opt_supported.yml',
			'test/fixtures/compose/services/volumes.yml',
			'test/fixtures/compose/services/volumes_allowed_bind_mount.yml',
			'test/fixtures/compose/services/volumes_allowed_bind_mount_partial.yml',
			'test/fixtures/compose/services/volumes_from.yml',
			'test/fixtures/compose/volumes/null.yml',
			'test/fixtures/compose/volumes/supported_fields.yml',
			'test/fixtures/parse-options/host-env.yml',
			'test/fixtures/secondary-files/extends-file.yml',
			'test/fixtures/secondary-files/extends-local.yml',
			'test/fixtures/secondary-files/include.yml',
			'test/fixtures/secondary-files/interpolated.yml',
			'test/fixtures/secondary-files/label_file.yml',
			'test/fixtures/secondary-files/long-form.yml',
			'test/fixtures/secondary-files/traversal.yml',
		];

		for (const fixture of fixtures) {
			it(`round-trips ${fixture}`, async () => {
				const original = await parse(fixture, { hostEnvironment: true });
				const reparsed = await reparse(original);
				expect(reparsed).to.deep.equal(original);
			});
		}
	});

	describe('what the builder receives', () => {
		it('needs no secondary files, so the default parse accepts it', async () => {
			// Three kinds of reference in one go: an env_file, a label_file and an
			// include. All folded by the first parse, none present after.
			for (const fixture of [
				'test/fixtures/compose/services/env_file.yml',
				'test/fixtures/compose/services/label_file.yml',
				'test/fixtures/compose/include/main.yml',
				'test/fixtures/secondary-files/extends-file.yml',
			]) {
				const original = await parse(fixture, { hostEnvironment: true });
				const text = serialize(original);
				expect(text, fixture).to.not.match(
					/^\s*(env_file|label_file|include|extends):/m,
				);
				// The same rejection the builder would apply, and no rejection here
				await reparse(original, {});
			}
		});

		it('keeps a value the first parse took from the host environment', async () => {
			const key = 'SECRET_BALENA_PASSWORD';
			const previous = process.env[key];
			process.env[key] = 'from-the-cli';
			try {
				const original = await parse(
					'test/fixtures/parse-options/host-env.yml',
					{ hostEnvironment: true },
				);
				expect(original.services.app.environment).to.deep.equal({
					[key]: 'from-the-cli',
					INTERPOLATED: 'from-the-cli',
				});

				// Now the builder's side, with a different value in its environment
				// that must not leak in.
				process.env[key] = 'from-the-builder';
				const reparsed = await reparse(original);
				expect(reparsed.services.app.environment).to.deep.equal({
					[key]: 'from-the-cli',
					INTERPOLATED: 'from-the-cli',
				});
			} finally {
				if (previous === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = previous;
				}
			}
		});

		it('carries interpolated values, which are not interpolated again', async () => {
			const vars = {
				IMAGE_TAG: '3.18',
				APP_PORT: '8080',
				APP_ENV: 'production',
				DB_NAME: 'myapp_db',
			};
			const previous = Object.fromEntries(
				Object.keys(vars).map((key) => [key, process.env[key]]),
			);
			Object.assign(process.env, vars);
			try {
				const original = await parse(
					'test/fixtures/compose/interpolation/compose.yml',
					{ hostEnvironment: true },
				);
				expect(original.services.main.ports).to.deep.equal(['8080:8080']);

				// Different values on the builder, none of which may show through
				Object.assign(process.env, { IMAGE_TAG: 'x', APP_PORT: '1' });
				const reparsed = await reparse(original);
				expect(reparsed).to.deep.equal(original);
			} finally {
				for (const [key, value] of Object.entries(previous)) {
					if (value === undefined) {
						delete process.env[key];
					} else {
						process.env[key] = value;
					}
				}
			}
		});

		it('keeps a literal dollar sign literal when interpolation is off', async () => {
			const original: Composition = {
				services: {
					main: {
						image: 'alpine:latest',
						command: ['sh', '-c', 'echo $HOME ${NOT_SET:-x}'],
						environment: { PRICE: '$5' },
					},
				},
			};
			const reparsed = await reparse(original);
			expect(reparsed).to.deep.equal(original);
		});

		it('keeps strings that yaml.v3 would read as numbers', async () => {
			// js-yaml does not resolve these as numbers, so it would leave them
			// unquoted, but compose-go's yaml.v3 strips the underscores and does
			const original: Composition = {
				services: {
					main: {
						image: 'alpine:latest',
						command: ['sh', '-c', '1_000'],
						environment: { A: '1_000', H: '0x_1', I: '1e1_0' },
						labels: { 'io.balena.features.x': '1_0' },
					},
				},
			};
			const reparsed = await reparse(original);
			expect(reparsed).to.deep.equal(original);
		});
	});
});
