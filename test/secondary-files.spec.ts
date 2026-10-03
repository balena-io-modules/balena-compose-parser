import { expect } from 'chai';
import * as path from 'path';

import { parse } from '../lib/compose';
import { ComposeError, ValidationError } from '../lib/errors';

const DIR = 'test/fixtures/secondary-files';

describe('secondary files', () => {
	const rejected = [
		['services.app.env_file', `${DIR}/traversal.yml`],
		['services.app.label_file', `${DIR}/label_file.yml`],
		['include', `${DIR}/include.yml`],
		['services.app.extends.file', `${DIR}/extends-file.yml`],
		['services.app.env_file', `${DIR}/multi-document.yml`],
		['services.app.env_file', `${DIR}/merge-key.yml`],
		['services.app.env_file', `${DIR}/interpolated.yml`],
	] as const;

	rejected.forEach(([field, fixture]) => {
		it(`rejects ${field} by default in ${path.basename(fixture)}`, async () => {
			await parse(fixture).then(
				() => {
					throw new Error(`Expected ${field} to be rejected`);
				},
				(err: ComposeError) => {
					expect(err.message).to.contain(
						'secondary file references are not allowed',
					);
					expect(err.message).to.contain(field);
				},
			);
		});
	});

	it('throws an error a consumer can match on', async () => {
		const err = await parse(`${DIR}/traversal.yml`).catch((e) => e);

		expect(err).to.be.instanceOf(ValidationError);
	});

	it('allows them when asked', async () => {
		const composition = await parse(`${DIR}/traversal.yml`, {
			hostEnvironment: true,
		});

		expect(composition.services.app.environment).to.deep.equal({
			OUTSIDE_SECRET: 'leaked',
		});
	});

	it('rejects before reading anything', async () => {
		// The check has to run before the parse, since compose-go folds these files
		// in as it loads. Rejecting afterwards would be too late.
		const composition = await parse(`${DIR}/traversal.yml`).catch(
			(err: ComposeError) => err,
		);

		expect(composition).to.be.instanceOf(ComposeError);
		expect(JSON.stringify(composition)).to.not.contain('leaked');
	});

	it('allows an empty list, which names no path', async () => {
		const composition = await parse(`${DIR}/empty-list.yml`);

		expect(composition.services.app.image).to.equal('alpine');
	});

	it('allows extends within the same file', async () => {
		const composition = await parse(`${DIR}/extends-local.yml`);

		expect(composition.services.app.image).to.equal('alpine');
	});
});
