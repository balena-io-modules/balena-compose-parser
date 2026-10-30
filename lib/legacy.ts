import type { Service } from './types';

// Fields newly supported by balena-compose-parser that were
// not supported by balena-compose previously. Services using any of these are
// rejected at parse time until a Supervisor that supports them is in production.
// Once it is, the rejection is to be replaced by a sw.spec/compose contract
// requirement so legacy Supervisors can reject the composition.
// TODO: When long syntax depends_on and long syntax volumes are supported
// (i.e. their rejections in normalizeService are removed), add them here.
export const NEW_COMPOSE_SERVICE_FIELDS = [
	'annotations',
	'cgroup',
	'cpu_rt_runtime',
	'cpu_rt_period',
	'cpus',
	'device_cgroup_rules',
	'uts',
];

// Sub-fields of service.healthcheck that are newly supported
const NEW_COMPOSE_HEALTHCHECK_FIELDS = ['start_interval'];

// Sub-fields of service.networks entries that are newly supported
const NEW_COMPOSE_NETWORK_FIELDS = [
	'ipv6_address',
	'mac_address',
	'driver_opts',
	'gw_priority',
	'priority',
];

// Warns and returns true if the service uses any newly supported field
export function usesNewComposeFields(service: Service): boolean {
	// Check top-level service fields
	for (const field of NEW_COMPOSE_SERVICE_FIELDS) {
		if (service[field as keyof Service] != null) {
			console.warn(`service.${field} is not supported`);
			return true;
		}
	}

	// pid=service:${serviceName} is newly supported; pid=host was already supported
	if (service.pid?.startsWith('service:')) {
		console.warn('service.pid service:${serviceName} is not supported');
		return true;
	}

	// Check healthcheck sub-fields
	if (service.healthcheck) {
		for (const field of NEW_COMPOSE_HEALTHCHECK_FIELDS) {
			if (
				service.healthcheck[
					field as keyof NonNullable<Service['healthcheck']>
				] != null
			) {
				console.warn(`service.healthcheck.${field} is not supported`);
				return true;
			}
		}
	}

	// Check per-service network sub-fields
	if (service.networks) {
		for (const network of Object.values(service.networks)) {
			if (network == null) {
				continue;
			}
			for (const field of NEW_COMPOSE_NETWORK_FIELDS) {
				if (network[field as keyof typeof network] != null) {
					console.warn(`service.network.${field} is not supported`);
					return true;
				}
			}
		}
	}

	return false;
}
