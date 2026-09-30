import { expect } from 'chai';
import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

import { parse } from '../lib/compose';

const execFileAsync = promisify(execFile);

const FIXTURE = 'test/fixtures/parse-options/host-env.yml';
const SECRET = 'hunter2-supersecret';

describe('parse options', () => {
	let previous: string | undefined;

	beforeEach(() => {
		previous = process.env.SECRET_BALENA_PASSWORD;
		process.env.SECRET_BALENA_PASSWORD = SECRET;
	});

	afterEach(() => {
		if (previous === undefined) {
			delete process.env.SECRET_BALENA_PASSWORD;
		} else {
			process.env.SECRET_BALENA_PASSWORD = previous;
		}
	});

	describe('hostEnvironment', () => {
		it('reads nothing from our environment by default', async () => {
			const composition = await parse(FIXTURE);

			// An unresolved valueless key comes back as '' rather than null,
			// because the API rejects null env var values.
			expect(composition.services.app.environment).to.deep.equal({
				SECRET_BALENA_PASSWORD: '',
				INTERPOLATED: '',
			});
		});

		it('reads it when asked', async () => {
			const composition = await parse(FIXTURE, { hostEnvironment: true });

			expect(composition.services.app.environment).to.deep.equal({
				SECRET_BALENA_PASSWORD: SECRET,
				INTERPOLATED: SECRET,
			});
		});

		it('is what keeps a valueless entry out, not skipInterpolation', async () => {
			const composition = await parse(FIXTURE, {
				hostEnvironment: true,
				skipInterpolation: true,
			});

			// Why hostEnvironment exists as its own option. Interpolation is off
			// here, and the valueless entry still picks up our value.
			expect(composition.services.app.environment).to.deep.include({
				SECRET_BALENA_PASSWORD: SECRET,
			});
		});
	});

	describe('the binary on its own', () => {
		// Two things keep our environment out, the Go side skipping WithOsEnv and
		// compose.ts passing an empty env. Call the binary directly so this covers
		// the Go side alone, which the tests above cannot tell apart.
		const binary = path.join(
			__dirname,
			'..',
			'bin',
			process.platform === 'win32'
				? 'balena-compose-parser.exe'
				: 'balena-compose-parser',
		);

		it('ignores its own environment without --host-env', async () => {
			const { stdout } = await execFileAsync(binary, ['-f', FIXTURE, 'p'], {
				env: { ...process.env, SECRET_BALENA_PASSWORD: SECRET },
			});

			expect(JSON.parse(stdout).services.app.environment).to.deep.equal({
				SECRET_BALENA_PASSWORD: null,
				INTERPOLATED: '',
			});
		});

		it('reads it with --host-env', async () => {
			const { stdout } = await execFileAsync(
				binary,
				['-f', FIXTURE, '--host-env', 'p'],
				{ env: { ...process.env, SECRET_BALENA_PASSWORD: SECRET } },
			);

			expect(JSON.parse(stdout).services.app.environment).to.deep.equal({
				SECRET_BALENA_PASSWORD: SECRET,
				INTERPOLATED: SECRET,
			});
		});
	});

	describe('skipInterpolation', () => {
		it('interpolates by default', async () => {
			const composition = await parse(FIXTURE, { hostEnvironment: true });

			expect(composition.services.app.environment).to.have.property(
				'INTERPOLATED',
				SECRET,
			);
		});

		it('leaves references verbatim when true', async () => {
			const composition = await parse(FIXTURE, {
				hostEnvironment: true,
				skipInterpolation: true,
			});

			expect(composition.services.app.environment).to.have.property(
				'INTERPOLATED',
				'${SECRET_BALENA_PASSWORD}',
			);
		});
	});
});
