import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Write `yaml` to a docker-compose.yml in a fresh directory, call `fn` with its
 * path, then remove the directory.
 */
export async function withComposeFile<T>(
	yaml: string,
	fn: (file: string) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), 'compose-parser-test-'));
	try {
		const file = join(dir, 'docker-compose.yml');
		await writeFile(file, yaml, 'utf8');
		return await fn(file);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Set environment variables, `undefined` meaning unset. Returns a function that
 * puts back what was there before.
 */
export function setEnv(vars: Record<string, string | undefined>): () => void {
	const previous = Object.fromEntries(
		Object.keys(vars).map((key) => [key, process.env[key]]),
	);
	const apply = (values: Record<string, string | undefined>) => {
		for (const [key, value] of Object.entries(values)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	};
	apply(vars);
	return () => {
		apply(previous);
	};
}

/** Run `fn` with environment variables set, restoring them afterwards. */
export async function withEnv<T>(
	vars: Record<string, string | undefined>,
	fn: () => Promise<T>,
): Promise<T> {
	const restore = setEnv(vars);
	try {
		return await fn();
	} finally {
		restore();
	}
}
