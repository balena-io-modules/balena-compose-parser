import { validRange } from 'semver';

import { ValidationError } from './errors';
import type { Dict, ContractObject, ContractWithChildren } from './types';

export interface ContractParser {
	validate(value: string, label: string): void;
	transform(value: string): ContractObject;
}

export const CONTRACT_REQUIREMENT_LABEL_PREFIX = 'io.balena.features.requires.';

function validateVersionRange(value: string, label: string) {
	if (validRange(value) == null) {
		throw new ValidationError(
			`Invalid value for label '${label}'. ` +
				'Expected a valid semver range; ' +
				`got '${value}'`,
		);
	}
}

const supportedOsSlugs = ['balena-os'];
const supportedKernelSlugs = ['linux'];

export const supportedContractRequirementLabels: Dict<ContractParser> = {
	'sw.supervisor': {
		validate(value, label) {
			validateVersionRange(value, label);
		},
		transform(value) {
			return { type: 'sw.supervisor', version: value };
		},
	},
	'sw.l4t': {
		validate(value, label) {
			validateVersionRange(value, label);
		},
		transform(value) {
			return { type: 'sw.l4t', version: value };
		},
	},
	'hw.device-type': {
		validate() {
			/* we might want to validate that the device type is a valid slug */
		},
		transform(value) {
			return { type: 'hw.device-type', slug: value };
		},
	},
	'arch.sw': {
		validate(value, label) {
			if (!['aarch64', 'rpi', 'amd64', 'armv7hf', 'i386'].includes(value)) {
				throw new ValidationError(
					`Invalid value for label '${label}'. ` +
						'Expected a valid architecture string ' +
						`got '${value}'`,
				);
			}
		},
		transform(value) {
			return { type: 'arch.sw', slug: value };
		},
	},
	...Object.fromEntries(
		supportedOsSlugs.map((slug) => [
			`sw.${slug}`,
			{
				validate(value: string, label: string) {
					validateVersionRange(value, label);
				},
				transform(value: string) {
					return { type: 'sw.os', slug, version: value };
				},
			},
		]),
	),
	...Object.fromEntries(
		supportedKernelSlugs.map((slug) => [
			`sw.${slug}`,
			{
				validate(value: string, label: string) {
					validateVersionRange(value, label);
				},
				transform(value: string) {
					return { type: 'sw.kernel', slug, version: value };
				},
			},
		]),
	),
};

export function validateContractLabels(labels: Dict<any>) {
	for (const [name, value] of Object.entries(labels)) {
		if (name.startsWith(CONTRACT_REQUIREMENT_LABEL_PREFIX)) {
			const ctype = name.replace(CONTRACT_REQUIREMENT_LABEL_PREFIX, '');
			if (ctype in supportedContractRequirementLabels) {
				supportedContractRequirementLabels[ctype].validate(value, name);
			}
		}
	}
}

export function createContractFromLabels(
	serviceName: string,
	labels?: Dict<string>,
	contractParser: Dict<ContractParser> = supportedContractRequirementLabels,
): ContractWithChildren | null {
	// sw.os and sw.kernel support multiple types, to be combined into an "or" clause
	const osRequires: ContractObject[] = [];
	const kernelRequires: ContractObject[] = [];
	const otherRequires: ContractObject[] = [];

	Object.entries(labels ?? {}).forEach(([key, value]) => {
		if (!key.startsWith(CONTRACT_REQUIREMENT_LABEL_PREFIX)) {
			return;
		}

		key = key.replace(CONTRACT_REQUIREMENT_LABEL_PREFIX, '');
		if (!(key in contractParser)) {
			return;
		}

		const parser = contractParser[key];
		const transformed = parser.transform(value);
		if (transformed.type === 'sw.os') {
			osRequires.push(transformed);
		} else if (transformed.type === 'sw.kernel') {
			kernelRequires.push(transformed);
		} else {
			otherRequires.push(transformed);
		}
	});

	if (
		otherRequires.length === 0 &&
		osRequires.length === 0 &&
		kernelRequires.length === 0
	) {
		return null;
	}

	const requires: ContractWithChildren[] = [
		...otherRequires,
		...(osRequires.length > 0 ? [{ or: osRequires }] : []),
		...(kernelRequires.length > 0 ? [{ or: kernelRequires }] : []),
	];

	return {
		type: 'sw.container',
		slug: `contract-for-${serviceName}`,
		requires,
	};
}
