import type { OSCValue } from './osc.js'
import { pathMatcher } from './commandTable.js'
import entitySchemas from './entity-schemas.json' with { type: 'json' }

export type EntityRecordDefinition = {
	responsePath: string
	fields: string
	queryPath?: string
	countPath?: string
	emptyChoicesLabel?: string
}

const definitions = entitySchemas as {
	records: Record<string, EntityRecordDefinition>
	targetCounts: Record<string, number>
}
const targetCounts = definitions.targetCounts

export type EntityRecord = {
	schemaPath: string
	index: number
	value: Record<string, number | string>
}

export function getEntityRecordDefinition(commandPath: string): EntityRecordDefinition | undefined {
	return definitions.records[commandPath]
}

export function entityRecordDefinitions(): EntityRecordDefinition[] {
	return Object.values(definitions.records)
}

/** Parse a record using the positional schema declared in entity-schemas.json. */
export function parseEntityRecord(path: string, args: OSCValue[]): EntityRecord | undefined {
	const definition = Object.values(definitions.records).find((candidate) =>
		pathMatcher(candidate.responsePath).test(path),
	)
	if (!definition) return undefined
	const schemaPath = definition.responsePath
	const schema = definition.fields
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
	return [...new Set(Object.values(definitions.records).map((definition) => definition.responsePath))]
}

export function entityRoots(): string[] {
	return [...new Set(entitySchemaPaths().map((path) => path.split('/').filter(Boolean)[0]))]
}

export function hasEntityRoot(root: string): boolean {
	return entitySchemaPaths().some((path) => path.startsWith(`/${root}/`))
}

export function entityTargetCount(section: string): number | undefined {
	return targetCounts[section]
}

export function entityTargetSections(): string[] {
	return Object.keys(targetCounts)
}
