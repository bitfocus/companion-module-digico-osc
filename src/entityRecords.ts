import type { OSCValue } from './osc.js'
import { pathMatcher } from './commandTable.js'
import entitySchemas from './entity-schemas.json' with { type: 'json' }

export type EntityRecordDefinition = {
	responsePath: string
	fields:
		| string
		| {
				prefix: string[]
				repeat: { count: number; fields: string[] }
		  }
	keyFields?: string[]
	collectRecords?: boolean
	selectorLabelFields?: string[]
	selectorLabel?: string
	selectorLabelTemplate?: string
	recordArraySelectors?: {
		position: EntityRecordPositionSelectorDefinition
		bank: EntityRecordBankSelectorDefinition
	}
	arrayResult?: { count: number; sectionField: string; indexField: string }
	queryOnStartup?: boolean
	queryPath?: string
	countPath?: string
	emptyChoicesLabel?: string
}

export type EntityRecordPositionSelectorDefinition = {
	id: string
	label: string
	groupFields: string[]
	sideLabels?: Record<string, string>
	indexField: string
	indexOffset: number
	labelTemplate: string
}

export type EntityRecordBankSelectorDefinition = {
	idPrefix: string
	label: string
	positionFields: string[]
	labelTemplate: string
	indexField: string
	nameField: string
}

const definitions = entitySchemas as {
	records: Record<string, EntityRecordDefinition>
	targetCounts: Record<string, number>
	listRoots?: string[]
}
const targetCounts = definitions.targetCounts

export type EntityRecord = {
	schemaPath: string
	key: string
	index?: number
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
	const fieldDefinition = definition.fields
	let fields: string[]
	if (typeof fieldDefinition === 'string') {
		fields = fieldDefinition.split(',')
	} else {
		const repeatedFields = fieldDefinition.repeat.fields
		fields = [
			...fieldDefinition.prefix,
			...Array.from({ length: fieldDefinition.repeat.count }, (_, position) =>
				repeatedFields.map((field) => `${field}_${position + 1}`),
			).flat(),
		]
	}
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
	const rawIndex = value.index
	const index = typeof rawIndex === 'number' && Number.isInteger(rawIndex) ? rawIndex : undefined
	const keyFields = definition.keyFields ?? ['index']
	const keyValues = keyFields.map((field) => value[field])
	if (keyValues.some((field) => field === undefined)) return undefined
	const key = keyFields.length === 1 && keyFields[0] === 'index' ? String(keyValues[0]) : JSON.stringify(keyValues)
	return { schemaPath, key, index, value }
}

export function entitySchemaPaths(): string[] {
	return [...new Set(Object.values(definitions.records).map((definition) => definition.responsePath))]
}

export function entityRoots(): string[] {
	return definitions.listRoots ?? [...new Set(entitySchemaPaths().map((path) => path.split('/').filter(Boolean)[0]))]
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
