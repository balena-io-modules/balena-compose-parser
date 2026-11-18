import { expect } from 'chai';

import { parse } from '../lib/compose';
import {
	ComposeError,
	ConfigError,
	ParseError,
	TimeoutError,
} from '../lib/errors';
import { withComposeFile } from './helpers';

describe('errors', () => {
	it('reports a file compose-go cannot parse as a ParseError', async () => {
		const err = await withComposeFile(
			'services:\n  app:\n    image: [bad\n',
			(file) => parse(file).catch((e) => e),
		);

		expect(err).to.be.instanceOf(ParseError);
		expect(err).to.be.instanceOf(ComposeError);
		expect(err.name).to.equal('ParseError');
		expect(err.message).to.contain('did not find expected');
	});

	it('reports a missing file as a ParseError', async () => {
		const err = await parse('/does/not/exist/docker-compose.yml').catch(
			(e) => e,
		);

		expect(err).to.be.instanceOf(ParseError);
		expect(err.message).to.contain('no such file');
	});

	// Neither is reachable through parse() without a slow or broken parse, so
	// only the shape a consumer would match on is checked.
	it('names TimeoutError and ConfigError after what the binary emits', () => {
		expect(new TimeoutError('slow')).to.be.instanceOf(ComposeError);
		expect(new TimeoutError('slow').name).to.equal('TimeoutError');
		expect(new ConfigError('bad').name).to.equal('ConfigError');
	});
});
