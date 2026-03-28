import { exec as execSync } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import * as path from 'path';

import {
	ComposeError,
	ValidationError,
	ArgumentError,
	ServiceError,
} from './errors';
import { validateContractLabels, createContractFromLabels } from './contracts';
import { usesNewComposeFields } from './legacy';
import type {
	Composition,
	Dict,
	Service,
	BuildConfig,
	Network,
	Volume,
	DevicesConfig,
	ServiceVolumeConfig,
	ImageDescriptor,
} from './types';

const exec = promisify(execSync);

/**
 * Parse one or more compose files using compose-go, and return a normalized composition object
 * @param composeFilePaths - Path(s) to the compose file(s) to parse. Can be a single string or an array of strings.
 * @returns Normalized composition object
 */
export async function parse(
	composeFilePaths: string | string[],
): Promise<Composition> {
	// Normalize input to always be an array
	const filePaths = Array.isArray(composeFilePaths)
		? composeFilePaths
		: [composeFilePaths];

	// Validate that at least one file path is provided
	if (filePaths.length === 0) {
		throw new ArgumentError('At least one compose file path must be provided');
	}

	// Use a random UUID as the project name so it's easy to remove later,
	// as balena doesn't use the project name, but compose-go injects it in several places.
	const projectName = randomUUID();

	// Build the command with -f flags for each file
	const fileFlags = filePaths.map((filePath) => `-f ${filePath}`).join(' ');

	const binaryName =
		process.platform === 'win32'
			? 'balena-compose-parser.exe'
			: 'balena-compose-parser';
	const binaryPath = path.join(__dirname, '..', 'bin', binaryName);
	const result = await exec(`${binaryPath} ${fileFlags} ${projectName}`, {
		env: process.env,
	}).catch((e) => {
		// If exec error has stdout/stderr, handle them later; otherwise throw immediately
		if (e.stdout !== undefined && e.stderr !== undefined) {
			return e;
		}
		throw e;
	});

	const { stdout, stderr } = result;

	if (stderr) {
		// Compose-go logs warnings to stderr, and we don't need to throw for those. Just ignore them for now.
		// TODO: Revisit ignoring warnings once we achieve maximum compose spec v2 support
		const errorsOrWarnings = toComposeError(stderr);
		const errors = errorsOrWarnings.filter((e: ComposeError) =>
			['error', 'fatal', 'panic'].includes(e.level),
		);
		// Only throw the first error
		if (errors.length > 0) {
			throw errors[0];
		}
	}

	// Parse the stdout directly as the composition data
	const parsedResult = JSON.parse(stdout) as Dict<any>;

	// Normalize raw composition into a balena-acceptable composition
	// Use the first file path as the base for relative path calculations
	return normalize(parsedResult, filePaths[0]);
}

/**
 * Convert stderr output from compose-go into a list of ComposeError objects
 * @param stderr - stderr string output from compose-go
 * @returns List of ComposeErrors
 */
function toComposeError(stderr: string): ComposeError[] {
	const errors: ComposeError[] = [];
	const lines = stderr.split('\n').filter((line) => line.trim() !== '');
	lines.forEach((line) => {
		try {
			const parsed = JSON.parse(line);

			// Both our custom error format and logrus JSON format have 'message' field
			if (parsed.message) {
				errors.push(
					new ComposeError(
						parsed.message,
						parsed.level ?? 'error',
						parsed.name,
					),
				);
			}
		} catch {
			// If JSON parsing fails, warn and skip this line
			console.warn(`Could not parse stderr line as JSON: ${line}`);
		}
	});
	return errors;
}

function normalize(
	rawComposition: Dict<any>,
	composeFilePath: string,
): Composition {
	const composition: Composition = {
		services: {},
	};

	// Balena doesn't make use of the project name, but it's injected into the
	// names of networks and volumes by compose-go, so must be removed without rejecting.
	removeProjectName(rawComposition);

	// Reject top-level secrets & configs
	if (rawComposition.secrets || rawComposition.configs) {
		throw new ValidationError(
			'Top-level secrets and/or configs are not supported',
		);
	}

	if (rawComposition.services) {
		for (const [serviceName, service] of Object.entries(
			rawComposition.services,
		)) {
			composition.services[serviceName] = normalizeService(
				service as Dict<any>,
				composeFilePath,
				serviceName,
			);
		}
	}

	if (rawComposition.networks) {
		composition.networks = {};
		for (const [networkName, network] of Object.entries(
			rawComposition.networks,
		)) {
			composition.networks[networkName] = normalizeNetwork(
				network as Dict<any>,
			);
		}
	}

	if (rawComposition.volumes) {
		composition.volumes = {};
		for (const [volumeName, volume] of Object.entries(rawComposition.volumes)) {
			composition.volumes[volumeName] = normalizeVolume(volume as Dict<any>);
		}
	}

	return composition;
}

/**
 * Remove project name based on top-level `name` key, and any nested values that
 * contain the project name. compose-go injects the project name into the composition
 * in network.name and volume.name which aren't used by balena
 * as the Supervisor uses its own naming scheme for networks and volumes.
 * @param obj - Composition object to remove name from
 */
function removeProjectName(obj: Dict<any>) {
	if (obj.name) {
		delete obj.name;
	}

	if (obj.networks) {
		for (const [, network] of Object.entries(obj.networks)) {
			removeProjectName(network as Dict<any>);
		}
	}

	if (obj.volumes) {
		for (const [, volume] of Object.entries(obj.volumes)) {
			removeProjectName(volume as Dict<any>);
		}
	}
}

export const SERVICE_CONFIG_DENY_LIST = [
	'blkio_config',
	'configs',
	'cpu_count',
	'cpu_percent',
	'cpu_period',
	// 'cpu_quota', // TODO: Currently supported, but should remove support as kernel 6.6+ does not use CFS which this configures
	'credential_spec',
	'deploy',
	'develop',
	'external_links',
	'gpus',
	'isolation',
	'links',
	'logging',
	'mem_swappiness',
	'memswap_limit',
	'oom_kill_disable',
	'platform',
	// TODO: Currently compose-go does not include a service with profiles set if they're not specified in COMPOSE_PROFILES,
	// so a composition with profiles doesn't actually reject as the profiles are not added to the parsed compose by compose-go.
	// We should support profiles which will involve modifying this code, but in dedicated shaping + building cycles.
	// 'profiles',
	'pull_policy',
	'runtime',
	'scale',
	'secrets',
	'stdin_open',
	'storage_opt',
];

const OOM_SCORE_ADJ_WARN_THRESHOLD = -900;

const bindMountByLabel: Array<[string, string[]]> = [
	['io.balena.features.balena-socket', ['/var/run/docker.sock']],
	['io.balena.features.balena-socket', ['/var/run/balena-engine.sock']],
	['io.balena.features.dbus', ['/run/dbus']],
	['io.balena.features.sysfs', ['/sys']],
	['io.balena.features.procfs', ['/proc']],
	['io.balena.features.kernel-modules', ['/lib/modules']],
	['io.balena.features.firmware', ['/lib/firmware']],
	[
		'io.balena.features.journal-logs',
		['/var/log/journal', '/run/log/journal', '/etc/machine-id'],
	],
];

const allowedBindMounts = bindMountByLabel.flatMap(
	([_, appliedBindMounts]) => appliedBindMounts,
);

function normalizeService(
	rawService: Dict<any>,
	composeFilePath: string,
	serviceName: string,
): Service {
	const service: Service = { ...rawService };

	// Reject if unsupported fields are present
	for (const field of SERVICE_CONFIG_DENY_LIST) {
		if (field in service) {
			throw new ServiceError(`service.${field} is not allowed`, serviceName);
		}
	}

	if (rawService.build) {
		service.build = normalizeServiceBuild(
			rawService.build,
			composeFilePath,
			serviceName,
		);
	}

	// Warn if io.balena.private namespace is used for labels
	if (service.labels) {
		validateLabels(service.labels);
	}

	// Reject network_mode:container:${containerId} as we don't support this
	if (service.network_mode?.match(/^container:.*$/)) {
		throw new ServiceError(
			'service.network_mode container:${containerId} is not allowed',
			serviceName,
		);
	}

	// Reject pid:container:${containerId} as we don't support this
	if (service.pid?.match(/^container:.*$/)) {
		throw new ServiceError(
			'service.pid container:${containerId} is not allowed',
			serviceName,
		);
	}

	// Reject all security_opt settings except no-new-privileges
	if (service.security_opt?.some((opt) => !opt.match('no-new-privileges'))) {
		throw new ServiceError(
			'Only no-new-privileges is allowed for service.security_opt',
			serviceName,
		);
	}

	// Reject volumes_from which references container:${containerId}
	if (service.volumes_from?.some((v) => v.match(/^container:.*$/))) {
		throw new ServiceError(
			'service.volumes_from which references a containerId is not allowed',
			serviceName,
		);
	}

	// Reject service.ipc which references service:${serviceName} as Supervisor doesn't support this yet
	if (service.ipc && service.ipc !== 'shareable') {
		throw new ServiceError(
			'service.ipc which references service:${serviceName} is not supported',
			serviceName,
		);
	}

	// Reject service.network.link_local_ips as Supervisor doesn't support this yet
	if (service.networks) {
		for (const [, network] of Object.entries(service.networks)) {
			if (network?.link_local_ips) {
				throw new ServiceError(
					'service.network.link_local_ips is not supported',
					serviceName,
				);
			}
		}
	}

	// Reject negative pids_limit as Supervisor doesn't support this yet
	if (service.pids_limit && service.pids_limit < 0) {
		throw new ServiceError(
			'negative service.pids_limit is not supported',
			serviceName,
		);
	}

	// Remove null entrypoint
	/// compose-go adds `entrypoint: null` if entrypoint is unspecified.
	/// In docker-compose, this means that the default entrypoint from the image is used, but in
	/// balena, it overrides any ENTRYPOINT directive in the Dockerfile.
	/// See: https://docs.docker.com/reference/compose-file/services/#entrypoint
	if (service.entrypoint === null) {
		delete service.entrypoint;
	}

	// Convert long syntax ports to short syntax
	/// compose-go converts all port definitions to long syntax, however legacy Supervisors don't support this.
	/// TODO: Support this in Helios
	if (service.ports) {
		service.ports = longToShortSyntaxPorts(service.ports);
	}

	// Convert long syntax depends_on to short syntax
	/// compose-go converts all depends_on definitions to long syntax, however legacy Supervisors don't support this.
	/// TODO: Support this in Helios
	if (service.depends_on) {
		service.depends_on = longToShortSyntaxDependsOn(
			service.depends_on,
			serviceName,
		);
	}

	// Convert long syntax devices to short syntax
	/// compose-go converts all devices definitions to long syntax, however legacy Supervisors don't support this.
	/// TODO: Support this in Helios
	if (service.devices) {
		service.devices = longToShortSyntaxDevices(
			service.devices as DevicesConfig[],
			serviceName,
		);
	}

	if (service.volumes) {
		// At this point, service.volumes hasn't been converted to string[]
		// so it's safe to cast to ServiceVolumeConfig[], as compose-go converts
		// all volumes definitions to long syntax.
		const v = service.volumes as ServiceVolumeConfig[];

		// Convert allowed bind mounts to labels
		const labels = allowedBindMountsToLabels(v);

		if (labels.length > 0) {
			service.labels = {
				...service.labels,
				...Object.fromEntries(labels.map((label) => [label, '1'])),
			};
		}

		// Convert long syntax volumes to short syntax
		/// compose-go converts all volumes definitions to long syntax, however legacy Supervisors don't support this.
		/// TODO: Support this in Helios
		const { shortSyntaxVolumes, shortSyntaxTmpfs } = longToShortSyntaxVolumes(
			v,
			serviceName,
		);
		if (shortSyntaxVolumes.length > 0) {
			service.volumes = shortSyntaxVolumes;
		} else {
			delete service.volumes;
		}
		if (shortSyntaxTmpfs.length > 0) {
			service.tmpfs = [...(service.tmpfs ?? []), ...shortSyntaxTmpfs];
		}
	}

	// Add image as build tag if present
	if (service.image && service.build) {
		service.build.tags = [...(service.build.tags ?? []), service.image];
	}

	// Delete env_file, as compose-go adds env_file vars to service.environment
	delete service.env_file;

	// Delete label_file, as compose-go adds label_file labels to service.labels
	delete service.label_file;

	// Warn that expose is informational only
	if (service.expose) {
		console.warn(
			'service.expose is informational only. Removing from the composition',
		);
		delete service.expose;
	}

	// Warn of risks of breaking device functionality with oom_score_adj <= OOM_SCORE_ADJ_WARN_THRESHOLD
	if (
		service.oom_score_adj &&
		service.oom_score_adj <= OOM_SCORE_ADJ_WARN_THRESHOLD
	) {
		console.warn(
			`service.oom_score_adj values under ${OOM_SCORE_ADJ_WARN_THRESHOLD} may break device functionality`,
		);
	}

	// 	Warn that container_name is not supported and remove it
	if (service.container_name) {
		console.warn(
			'service.container_name is not supported. Removing from the composition',
		);
		delete service.container_name;
	}

	return service;
}

export const BUILD_CONFIG_DENY_LIST = [
	'additional_contexts',
	'cache_to',
	'dockerfile_inline',
	'entitlements',
	'isolation',
	'network',
	'no_cache',
	'platforms',
	'privileged',
	'pull',
	'secrets',
	'ssh',
	'tags',
	'ulimits',
];

function normalizeServiceBuild(
	rawServiceBuild: Dict<any>,
	composeFilePath: string,
	serviceName: string,
): BuildConfig {
	const build: BuildConfig = { ...rawServiceBuild };

	// Reject if unsupported fields are present
	for (const field of BUILD_CONFIG_DENY_LIST) {
		if (field in build) {
			throw new ServiceError(
				`service.build.${field} is not allowed`,
				serviceName,
			);
		}
	}

	// Warn if io.balena.private namespace is used for labels
	if (build.labels) {
		validateLabels(build.labels);
	}

	// Convert absolute context paths to relative paths
	/// compose-go converts relative context to absolute, but the existing image build methods
	/// in balena-compose rely on relative paths.
	if (build.context) {
		/// Reject if remote context (ends with .git) as we don't currently support this
		if (build.context.endsWith('.git')) {
			throw new ServiceError(
				`service.build.context cannot be a remote context`,
				serviceName,
			);
		}

		build.context =
			path.relative(path.dirname(composeFilePath), build.context) || '.';
	}
	return build;
}

export const NAMESPACED_LABEL_ERROR_MESSAGE =
	'The "io.balena.private" namespace is reserved for Balena system labels.';
function validateLabels(labels: Dict<any>) {
	for (const name of Object.keys(labels)) {
		// Warn if io.balena.private label namespace
		if (name.startsWith('io.balena.private')) {
			console.warn(NAMESPACED_LABEL_ERROR_MESSAGE);
		}
	}

	// Validate contract labels
	validateContractLabels(labels);
}

function longToShortSyntaxPorts(
	ports: NonNullable<Service['ports']>,
): string[] {
	const shortSyntaxPorts: string[] = [];
	const ignoredFields = ['name', 'app_protocol', 'mode'];

	for (const port of ports) {
		if (typeof port === 'string') {
			shortSyntaxPorts.push(port);
		} else if (typeof port === 'object') {
			// All long syntax configs are convertible to short syntax,
			// but some fields in long syntax are ignored if present:
			// - name: ignored as it doesn't serve a purpose in the service besides documentation
			// - app_protocol: ignored
			// - mode: ignored as we don't support Swarm features
			// See: https://docs.docker.com/reference/compose-file/services/#long-syntax-4
			for (const field of ignoredFields) {
				if (field in port) {
					console.warn(
						`service.ports.${field} is not supported. Removing from the composition`,
					);
					delete (port as any)[field];
				}
			}
			shortSyntaxPorts.push(
				(port.host_ip ? `${port.host_ip}:` : '') +
					`${port.published ? `${port.published}:` : ''}${port.target}` +
					// Only include protocol if it's not default (not TCP)
					(port.protocol !== 'tcp' ? `/${port.protocol}` : ''),
			);
		}
	}

	return shortSyntaxPorts;
}

function longToShortSyntaxDependsOn(
	dependsOn: NonNullable<Service['depends_on']>,
	serviceName: string,
): string[] {
	const shortSyntaxDependsOn: string[] = [];

	for (const [dependentServiceName, dependsOnConfig] of Object.entries(
		dependsOn,
	)) {
		// Some dependsOnConfigs are not convertible to short syntax, and may define a different depends_on behavior
		// than the short syntax default. We don't support long syntax depends_on in legacy Supervisors, so warn for now
		// and convert to short syntax although the dependency behavior is slightly different.
		// Short syntax depends_on is equivalent to long syntax condition: service_started and required: true
		if (
			dependsOnConfig.condition !== 'service_started' ||
			dependsOnConfig.required !== true
		) {
			throw new ServiceError(
				`Long syntax depends_on ${dependentServiceName}:${JSON.stringify(dependsOnConfig)} ` +
					`for service "${serviceName}" is not yet supported`,
				serviceName,
			);
		}

		// If required is false, the service is optional, so we don't need to express a dependency
		// TODO: Compose warns if service isn't started or available if required=false.
		//       Supervisor will need to warn once it supports long syntax depends_on.
		if (dependsOnConfig.required !== false) {
			shortSyntaxDependsOn.push(dependentServiceName);
		}
	}

	return shortSyntaxDependsOn;
}

function longToShortSyntaxDevices(
	devices: NonNullable<DevicesConfig[]>,
	serviceName: string,
): string[] {
	const shortSyntaxDevices: string[] = [];
	const CDIRegex = new RegExp('^(?!/)');

	for (const deviceConfig of devices) {
		// Reject if CDI syntax is used, we don't intend to support this
		if (
			CDIRegex.test(deviceConfig.source) ||
			CDIRegex.test(deviceConfig.target)
		) {
			throw new ServiceError(
				`devices config with CDI syntax is not allowed`,
				serviceName,
			);
		}

		shortSyntaxDevices.push(
			`${deviceConfig.source}:${deviceConfig.target}:${deviceConfig.permissions}`,
		);
	}

	return shortSyntaxDevices;
}

function allowedBindMountsToLabels(volumes: ServiceVolumeConfig[]): string[] {
	const labels: string[] = [];
	bindMountByLabel.forEach(([label, appliedBindMounts]) => {
		// EVERY bind mount associated with the label must be present for the label to be applied,
		// except in the case of balena-engine label which only requires one of either bind mount
		if (
			appliedBindMounts.every((m) =>
				volumes.some((v) => v.source && v.source === m),
			)
		) {
			labels.push(label);
		}
	});
	return labels;
}

function longToShortSyntaxVolumes(
	volumes: ServiceVolumeConfig[],
	serviceName: string,
): { shortSyntaxVolumes: string[]; shortSyntaxTmpfs: string[] } {
	const shortSyntaxVolumes: string[] = [];
	const shortSyntaxTmpfs: string[] = [];

	for (const v of volumes) {
		// Ignore allowed bind mounts as they're converted to labels separately
		if (v.source && allowedBindMounts.includes(v.source)) {
			continue;
		}

		// Reject volumes of type bind, image, npipe, or cluster
		if (['bind', 'image', 'npipe', 'cluster'].includes(v.type)) {
			throw new ServiceError(
				`service.volumes cannot be of type "${v.type}"`,
				serviceName,
			);
		}

		// Reject volumes if options are specified that can't be converted to short syntax
		const isLongSyntaxTmpfs =
			v.type === 'tmpfs' && v.tmpfs && Object.keys(v.tmpfs).length > 0;
		const isLongSyntaxVolume =
			v.type === 'volume' && v.volume && Object.keys(v.volume).length > 0;
		if (isLongSyntaxTmpfs || isLongSyntaxVolume) {
			throw new ServiceError(
				`long syntax service.volumes are not supported`,
				serviceName,
			);
		}

		if (v.type === 'volume' && (!v.source || !v.target)) {
			throw new ServiceError(
				`service.volumes ${JSON.stringify(v)} must specify source and target`,
				serviceName,
			);
		}

		if (v.type === 'volume') {
			shortSyntaxVolumes.push(
				`${v.source}:${v.target}${v.read_only ? ':ro' : ''}`,
			);
		} else if (v.type === 'tmpfs' && v.target) {
			shortSyntaxTmpfs.push(v.target);
		}
	}

	return { shortSyntaxVolumes, shortSyntaxTmpfs };
}

export const NETWORK_CONFIG_DENY_LIST = ['attachable', 'external'];

function normalizeNetwork(rawNetwork: Dict<any>): Network {
	const network: Network = { ...rawNetwork };

	// Reject if unsupported fields are present
	for (const field of NETWORK_CONFIG_DENY_LIST) {
		if (field in network) {
			throw new ValidationError(`network.${field} is not allowed`);
		}
	}

	// Reject if driver is not bridge
	if (network.driver && !['bridge', 'default'].includes(network.driver)) {
		throw new ValidationError(
			`Only "bridge" and "default" are supported for network.driver, got "${network.driver}"`,
		);
	}

	// Warn if `io.balena.private` namespace is used for labels
	if (network.labels) {
		validateLabels(network.labels);
	}

	// Reject network.ipam.config.aux_addresses as Supervisor doesn't support this yet
	if (network.ipam?.config?.some((config) => config.aux_addresses)) {
		throw new ValidationError(
			'network.ipam.config.aux_addresses is not supported',
		);
	}

	// Reject enable_ipv4 as it's not supported by Podman and not
	// useful without enable_ipv6 support (for ipv6-only networks)
	if (network.enable_ipv4 != null) {
		throw new ValidationError('enable_ipv4 is not supported');
	}
	// Reject enable_ipv6 as Engine doesn't support this yet
	if (network.enable_ipv6) {
		throw new ValidationError('enable_ipv6 is not supported');
	}

	// Warn if com.docker.network.bridge.name driver_opts is present as it may interfere with device firewall
	if (network.driver_opts?.['com.docker.network.bridge.name']) {
		console.warn(
			'com.docker.network.bridge.name network.driver_opt may interfere with device firewall',
		);
	}

	return network;
}

export const VOLUME_CONFIG_DENY_LIST = ['external'];

function normalizeVolume(rawVolume: Dict<any>): Volume {
	const volume: Volume = { ...rawVolume };

	// Reject if non-local driver is used
	if (volume.driver && !['local', 'default'].includes(volume.driver)) {
		throw new ValidationError(
			`Only "local" and "default" are supported for volume.driver, got "${volume.driver}"`,
		);
	}

	// Reject if unsupported fields are present
	for (const field of VOLUME_CONFIG_DENY_LIST) {
		if (field in volume) {
			throw new ValidationError(`volume.${field} is not allowed`);
		}
	}

	// Warn	 if `io.balena.private` namespace is used for labels
	if (volume.labels) {
		validateLabels(volume.labels);
	}

	return volume;
}

/**
 * Transforms a normalized composition into a list of image descriptors
 * that can be used to pull or build a service image.
 */
export function toImageDescriptors(c: Composition): ImageDescriptor[] {
	return Object.entries(c.services).map(([name, service]) => {
		return createImageDescriptor(name, service);
	});
}

function createImageDescriptor(
	serviceName: string,
	service: Service,
): ImageDescriptor {
	let contract = createContractFromLabels(serviceName, service.labels);

	// If the service uses newly supported compose fields, add a sw.compose
	// contract requirement so that legacy Supervisors can reject the composition.
	// Version 2 corresponds to Compose Spec v2: https://docs.docker.com/reference/compose-file/
	if (usesNewComposeFields(service)) {
		console.warn(
			`Service "${serviceName}" uses compose fields that may not be supported on legacy Supervisor versions`,
		);
		const composeRequirement = { type: 'sw.compose', version: '>=2' };
		if (contract && 'requires' in contract) {
			(contract.requires as any[]).push(composeRequirement);
		} else {
			contract = {
				type: 'sw.container',
				slug: `contract-for-${serviceName}`,
				requires: [composeRequirement],
			};
		}
	}

	if (service.image && !service.build) {
		return {
			serviceName,
			image: service.image,
			...(contract && { contract }),
		};
	}
	const build = service.build!;
	return {
		serviceName,
		image: build,
		...(contract && { contract }),
	};
}
