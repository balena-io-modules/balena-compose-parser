import { expect } from 'chai';
import { readdirSync } from 'node:fs';
import { join, posix, sep, win32 } from 'node:path';
import type { SinonStub } from 'sinon';
import { stub } from 'sinon';

import { parse, serialize } from '../lib/index';
import type { Composition, ParseOptions } from '../lib/index';
import { ServiceError } from '../lib/errors';
import { toPosixBuildContext } from '../lib/serialize';
import { setEnv, withComposeFile, withEnv } from './helpers';

/**
 * Write the serialized composition to a fresh directory and parse it the way
 * the builder does: no host environment, so nothing outside the file is read,
 * and interpolation off, so a literal `$` stays literal.
 */
async function reparse(
	composition: Composition,
	options: ParseOptions = { skipInterpolation: true },
): Promise<Composition> {
	return withComposeFile(serialize(composition), (file) =>
		parse(file, options),
	);
}

// Valid, but not on their own
const NOT_STANDALONE = [
	// Only valid merged onto their *-base.yml
	/^compose\/merge\/.*-override(-\d+)?\.yml$/,
	// Needs IMAGE_TAG and others set, which a test below does
	/^compose\/interpolation\/compose\.yml$/,
];

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
					ports: ['::1:6001:6001', '127.0.0.1:8080:80', '8080:80/udp'],
				},
			},
		});
		expect(out).to.include("'[::1]:6001:6001'");
		expect(out).to.include("'127.0.0.1:8080:80'");
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

	it('leaves ports alone that are not strings or have no host address', () => {
		const ports = [{ target: 80, published: 8080 }, 8080, '8080:80', '80'];
		const out = serialize({
			services: { main: { image: 'alpine:latest', ports: ports as any } },
		});
		expect(out).to.not.include('[');
	});

	it('serializes a composition with no services', () => {
		expect(serialize({} as any)).to.equal('{}\n');
		expect(serialize({ volumes: { data: {} } } as any)).to.equal(
			'volumes:\n  data: {}\n',
		);
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

	it('writes a Windows build context with forward slashes', () => {
		expect(toPosixBuildContext('services\\api', 'main', win32)).to.equal(
			'services/api',
		);
		expect(toPosixBuildContext('.', 'main', win32)).to.equal('.');
	});

	it('keeps a backslash in a POSIX build context', () => {
		expect(toPosixBuildContext('foo\\bar', 'main', posix)).to.equal('foo\\bar');
	});

	it('rejects a build context it cannot make relative', () => {
		const cases = [
			['D:\\other', win32],
			['\\\\server\\share', win32],
			['/abs/other', posix],
		] as const;
		for (const [context, pathImpl] of cases) {
			expect(
				() => toPosixBuildContext(context, 'main', pathImpl),
				context,
			).to.throw(ServiceError, 'service.build.context must be relative');
		}
		expect(() =>
			serialize({ services: { main: { build: { context: '/abs/other' } } } }),
		).to.throw(ServiceError, 'service.build.context must be relative');
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
		// CLI showed the user. Only a fixture under unsupported/ may be rejected.
		const fixtures = readdirSync('test/fixtures', { recursive: true })
			.map((file) => String(file).split(sep).join('/'))
			.filter(
				(file) =>
					/\.ya?ml$/.test(file) &&
					!NOT_STANDALONE.some((pattern) => pattern.test(file)),
			)
			.sort();

		for (const fixture of fixtures) {
			const mayBeRejected = fixture.split('/').includes('unsupported');
			it(`round-trips ${fixture}`, async function () {
				let original: Composition;
				try {
					original = await parse(join('test/fixtures', fixture), {
						hostEnvironment: true,
					});
				} catch (error) {
					if (!mayBeRejected) {
						throw error;
					}
					this.skip();
				}
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
				// The same rejection the builder would apply, and no rejection here,
				// and the same composition at the end of it
				expect(await reparse(original, {}), fixture).to.deep.equal(original);
			}
		});

		it('keeps a value the first parse took from the host environment', async () => {
			const key = 'SECRET_BALENA_PASSWORD';
			await withEnv({ [key]: 'from-the-cli' }, async () => {
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
				setEnv({ [key]: 'from-the-builder' });
				const reparsed = await reparse(original);
				expect(reparsed.services.app.environment).to.deep.equal({
					[key]: 'from-the-cli',
					INTERPOLATED: 'from-the-cli',
				});
			});
		});

		it('carries interpolated values, which are not interpolated again', async () => {
			const vars = {
				IMAGE_TAG: '3.18',
				APP_PORT: '8080',
				APP_ENV: 'production',
				DB_NAME: 'myapp_db',
			};
			await withEnv(vars, async () => {
				const original = await parse(
					'test/fixtures/compose/interpolation/compose.yml',
					{ hostEnvironment: true },
				);
				expect(original.services.main.ports).to.deep.equal(['8080:8080']);

				// Different values on the builder, none of which may show through
				setEnv({ IMAGE_TAG: 'x', APP_PORT: '1' });
				const reparsed = await reparse(original);
				expect(reparsed).to.deep.equal(original);
			});
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
			// js-yaml does not resolve these as numbers, so left to itself it would
			// write them unquoted, and compose-go's yaml.v3 would then read them as
			// numbers.
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

		it('keeps map keys and names that yaml.v3 would read as numbers', async () => {
			// Same problem as above, but for keys, which js-yaml's forceQuotes
			// does not touch. Without quoting, compose-go reports a non-string key.
			await withComposeFile(
				`services:
  "1_0":
    image: alpine:latest
    environment: { "1_000": a, "0x_1": b, "+.5": c, "1e1_0": d }
    labels: { "1_0": e, "0o1_7": f }
    build: { context: ., args: { "0b1_0": g } }
    networks: { "1_0": null }
networks:
  "1_0": { labels: { "1__0": h } }
volumes:
  "1_0": { driver_opts: { "1_": i } }
`,
				async (file) => {
					const original = await parse(file, { hostEnvironment: true });
					expect(original.services['1_0'].environment).to.have.all.keys(
						'1_000',
						'0x_1',
						'+.5',
						'1e1_0',
					);
					const reparsed = await reparse(original);
					expect(reparsed).to.deep.equal(original);
				},
			);
		});

		it('round-trips every IPv6 host address form', async () => {
			await withComposeFile(
				`services:
  main:
    image: alpine:latest
    ports:
      - "[::1]:8080:80"
      - "[::1]:8081:81/udp"
      - "[::]:83:83"
      - "[fe80::1]:84:84"
      - "[::ffff:127.0.0.1]:85:85"
      - "[2001:db8::1]:8600-8601:8600-8601"
      - target: 87
        published: 8700
        host_ip: "::1"
        protocol: udp
`,
				async (file) => {
					const original = await parse(file, { hostEnvironment: true });
					// The Supervisor form, bare
					expect(original.services.main.ports).to.include('::1:8080:80');
					expect(original.services.main.ports).to.include(':::83:83');
					expect(original.services.main.ports).to.include('::1:8700:87/udp');
					const reparsed = await reparse(original);
					expect(reparsed).to.deep.equal(original);
				},
			);
		});

		it('keeps multi-line strings and whitespace exactly', async () => {
			const original: Composition = {
				services: {
					main: {
						image: 'alpine:latest',
						command: ['sh', '-c', 'echo one\necho two\n'],
						environment: {
							SCRIPT: 'line one\n  indented\n\ttabbed\n',
							TRAILING: 'space ',
							LEADING: ' space',
							CRLF: 'a\r\nb',
						},
						labels: { 'io.balena.note': 'first\nsecond' },
						healthcheck: {
							test: ['CMD-SHELL', 'curl -f http://localhost || exit 1'],
						},
					},
				},
			};
			const reparsed = await reparse(original);
			expect(reparsed).to.deep.equal(original);
		});
	});
});
