import type { Service } from './types';

// Fields newly supported by balena-compose-parser that were
// not supported by balena-compose previously. If a service uses any of these fields,
// we add a sw.compose contract requirement so that legacy Supervisors which don't support
// the new compose fields can gracefully reject the composition.
// TODO: When long syntax depends_on and long syntax volumes are supported
// (i.e. their rejections in normalizeService are removed), add them here.
export const NEW_COMPOSE_SERVICE_FIELDS = [
	'annotations',
	'attach',
	'cgroup',
	'cpu_rt_runtime',
	'cpu_rt_period',
	'cpus',
	'device_cgroup_rules',
	'post_start',
	'pre_stop',
	'uts',
	'volumes_from',
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

export function usesNewComposeFields(service: Service): boolean {
	// Check top-level service fields
	for (const field of NEW_COMPOSE_SERVICE_FIELDS) {
		if (service[field as keyof Service] != null) {
			return true;
		}
	}

	// pid=service:${serviceName} is newly supported; pid=host was already supported
	if (service.pid?.startsWith('service:')) {
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
					return true;
				}
			}
		}
	}

	return false;
}
