import entitySchemas from './entity-schemas.json' with { type: 'json' }
import type { OSCValue } from './osc.js'
import { pathMatcher } from './commandTable.js'

const definitions = entitySchemas as { records: Record<string, string>; targetCounts: Record<string, number> }

export type EntityRecord = { schemaPath: string; index: number; value: Record<string, number | string> }

/** Parse an entity list record using its positional schema; field names and scale come from JSON. */
export function parseEntityRecord(path: string, args: OSCValue[]): EntityRecord | undefined {
	const schemaPath = Object.keys(definitions.records).find((template) => pathMatcher(template).test(path))
	if (!schemaPath) return undefined
	const schema = definitions.records[schemaPath]
	const fields = schema.split(',')
	if (fields.length !== args.length) return undefined
	const value: Record<string, number | string> = {}
	for (const [position, field] of fields.entries()) {
		const [key, scaleText, decimalsText] = field.split('/')
		const raw = args[position]
		if (!key || (typeof raw !== 'number' && typeof raw !== 'string')) return undefined
		const scale = scaleText === undefined ? 1 : Number(scaleText)
		if (!Number.isFinite(scale) || scale === 0) return undefined
		value[key] =
			typeof raw === 'number' && decimalsText !== undefined
				? (raw / scale).toFixed(Number(decimalsText))
				: typeof raw === 'number'
					? raw / scale
					: raw
	}
	const index = value.index
	return typeof index === 'number' && Number.isInteger(index) ? { schemaPath, index, value } : undefined
}

export function entitySchemaPaths(): string[] {
	return Object.keys(definitions.records)
}

export function entityRoots(): string[] {
	return [...new Set(entitySchemaPaths().map((path) => path.split('/').filter(Boolean)[0]))]
}

export function hasEntityRoot(root: string): boolean {
	return Object.keys(definitions.records).some((path) => path.startsWith(`/${root}/`))
}

export function entityTargetCount(section: string): number | undefined {
	return definitions.targetCounts[section]
}

export function entityTargetSections(): string[] {
	return Object.keys(definitions.targetCounts)
}
