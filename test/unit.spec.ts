import { expect } from 'chai';

import { toImageDescriptors, createContractFromLabels } from '../lib/index';
import type { Composition, ContractParser } from '../lib/index';

describe('toImageDescriptors', () => {
	it('should include contract objects for services with contract requirement labels', () => {
		const composition: Composition = {
			services: {
				app: {
					image: 'myapp:latest',
					labels: {
						'io.balena.features.requires.sw.supervisor': '>=16.0.0',
						'io.balena.features.requires.hw.device-type': 'raspberrypi4-64',
						'io.balena.other.label': 'value',
					},
				},
				db: {
					image: 'postgres:13',
					labels: {
						'io.balena.features.requires.arch.sw': 'aarch64',
						'io.balena.features.requires.sw.l4t': '32.4.4',
					},
				},
			},
		};

		const descriptors = toImageDescriptors(composition);

		expect(descriptors).to.have.lengthOf(2);

		expect(descriptors[0]).to.deep.equal({
			serviceName: 'app',
			image: 'myapp:latest',
			contract: {
				type: 'sw.container',
				slug: 'contract-for-app',
				requires: [
					{ type: 'sw.supervisor', version: '>=16.0.0' },
					{ type: 'hw.device-type', slug: 'raspberrypi4-64' },
				],
			},
		});

		expect(descriptors[1]).to.deep.equal({
			serviceName: 'db',
			image: 'postgres:13',
			contract: {
				type: 'sw.container',
				slug: 'contract-for-db',
				requires: [
					{ type: 'arch.sw', slug: 'aarch64' },
					{ type: 'sw.l4t', version: '32.4.4' },
				],
			},
		});
	});

	it('should not include contract for services without contract requirement labels', () => {
		const composition: Composition = {
			services: {
				app: {
					image: 'myapp:latest',
					labels: {
						'io.balena.features.dbus': '1',
						'io.balena.other.label': 'value',
					},
				},
			},
		};

		const descriptors = toImageDescriptors(composition);

		expect(descriptors).to.have.lengthOf(1);
		expect(descriptors[0]).to.deep.equal({
			serviceName: 'app',
			image: 'myapp:latest',
		});
	});

	it('should handle mixed service configurations', () => {
		const composition: Composition = {
			services: {
				web: {
					image: 'nginx:alpine',
				},
				app: {
					build: {
						context: './app',
					},
					labels: {
						'io.balena.features.requires.sw.supervisor': '>=2.5.0',
					},
				},
				cache: {
					image: 'redis:7',
					labels: {
						'io.balena.features.requires.arch.sw': 'amd64',
					},
				},
			},
		};

		const descriptors = toImageDescriptors(composition);

		expect(descriptors).to.have.lengthOf(3);

		expect(descriptors[0]).to.deep.equal({
			serviceName: 'web',
			image: 'nginx:alpine',
		});

		expect(descriptors[1]).to.deep.equal({
			serviceName: 'app',
			image: {
				context: './app',
			},
			contract: {
				type: 'sw.container',
				slug: 'contract-for-app',
				requires: [{ type: 'sw.supervisor', version: '>=2.5.0' }],
			},
		});

		expect(descriptors[2]).to.deep.equal({
			serviceName: 'cache',
			image: 'redis:7',
			contract: {
				type: 'sw.container',
				slug: 'contract-for-cache',
				requires: [{ type: 'arch.sw', slug: 'amd64' }],
			},
		});
	});
});

describe('createContractFromLabels', () => {
	it('should correctly create a contract from labels', () => {
		const contract = createContractFromLabels('my-service', {
			'io.balena.features.requires.sw.supervisor': '>=16.1.0',
			'io.balena.features.requires.arch.sw': 'amd64',
			'io.balena.features.requires.hw.device-type': 'raspberrypi3',
			'io.balena.features.requires.sw.l4t': '<=5',
		});
		expect(contract).to.deep.equal({
			type: 'sw.container',
			slug: 'contract-for-my-service',
			requires: [
				{
					type: 'sw.supervisor',
					version: '>=16.1.0',
				},
				{
					type: 'arch.sw',
					slug: 'amd64',
				},
				{
					type: 'hw.device-type',
					slug: 'raspberrypi3',
				},
				{
					type: 'sw.l4t',
					version: '<=5',
				},
			],
		});
	});

	it('should support sw.os and sw.kernel label types', () => {
		const contract = createContractFromLabels('my-service', {
			'io.balena.features.requires.sw.balena-os': '>=3.0.0',
			'io.balena.features.requires.sw.linux': '>=6.1.0',
		});
		expect(contract).to.deep.equal({
			type: 'sw.container',
			slug: 'contract-for-my-service',
			requires: [
				{
					or: [
						{
							type: 'sw.os',
							slug: 'balena-os',
							version: '>=3.0.0',
						},
					],
				},
				{
					or: [
						{
							type: 'sw.kernel',
							slug: 'linux',
							version: '>=6.1.0',
						},
					],
				},
			],
		});
	});

	it('should support multiple sw.os and sw.kernel label types by combining them under an "or" clause', () => {
		// We only support one sw.os and one sw.kernel label type at the moment,
		// but we can pass in a fake parser that supports multiple OS and kernel types.
		const mockContractParser: Record<string, ContractParser> = {
			'sw.balena-os': {
				validate() {
					// no-op for testing
				},
				transform(value: string) {
					return { type: 'sw.os', slug: 'balena-os', version: value };
				},
			},
			'sw.ubuntu': {
				validate() {
					// no-op for testing
				},
				transform(value: string) {
					return { type: 'sw.os', slug: 'ubuntu', version: value };
				},
			},
			'sw.linux': {
				validate() {
					// no-op for testing
				},
				transform(value: string) {
					return { type: 'sw.kernel', slug: 'linux', version: value };
				},
			},
			'sw.freebsd': {
				validate() {
					// no-op for testing
				},
				transform(value: string) {
					return { type: 'sw.kernel', slug: 'freebsd', version: value };
				},
			},
		};
		const contract = createContractFromLabels(
			'my-service',
			{
				'io.balena.features.requires.sw.balena-os': '>=3.0.0',
				'io.balena.features.requires.sw.ubuntu': '>=20.04',
				'io.balena.features.requires.sw.linux': '>=6.1.0',
				'io.balena.features.requires.sw.freebsd': '>=14.0.0',
			},
			mockContractParser,
		);
		expect(contract).to.deep.equal({
			type: 'sw.container',
			slug: 'contract-for-my-service',
			requires: [
				{
					or: [
						{
							type: 'sw.os',
							slug: 'balena-os',
							version: '>=3.0.0',
						},
						{
							type: 'sw.os',
							slug: 'ubuntu',
							version: '>=20.04',
						},
					],
				},
				{
					or: [
						{
							type: 'sw.kernel',
							slug: 'linux',
							version: '>=6.1.0',
						},
						{
							type: 'sw.kernel',
							slug: 'freebsd',
							version: '>=14.0.0',
						},
					],
				},
			],
		});
	});
});
