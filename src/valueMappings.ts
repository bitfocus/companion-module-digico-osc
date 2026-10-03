import valueMappingsJson from './value-mappings.json' with { type: 'json' }
import type { CommandRow } from './commandTable.js'
import { isBooleanDataType } from './commandTable.js'

export type ValueMappingUse = 'action' | 'feedback'
type MappingValues = Record<string, string>
type ValueMapping = Partial<Record<ValueMappingUse, MappingValues>> & { values?: MappingValues }

const valueMappings = valueMappingsJson as Record<string, ValueMapping>

function pathValueKey(row: CommandRow): string {
	return row.oscPath.split('/').filter(Boolean).at(-1)?.toLowerCase() ?? ''
}

export function getValueMappingKey(row: CommandRow): string | undefined {
	if (isBooleanDataType(row.dataType) || (row.dataType === 'Int' && row.min === 0 && row.max === 1)) return 'boolean'
	const pathKey = pathValueKey(row)
	if (pathKey === 'modes' || pathKey === 'stereo_mode') return 'mode'
	if (valueMappings[pathKey]) return pathKey
	const numberedBase = pathKey.replace(/_\d+$/, '')
	return valueMappings[numberedBase] ? numberedBase : undefined
}

export function getValueMapping(row: CommandRow, use: ValueMappingUse): MappingValues | undefined {
	const key = getValueMappingKey(row)
	const mapping = key ? valueMappings[key] : undefined
	return mapping?.[use] ?? mapping?.values
}

export function getValueSelectorPath(row: CommandRow, rows: CommandRow[]): string | undefined {
	const [root, section, command] = row.oscPath.split('/').filter(Boolean)
	if (root !== 'Console' || command !== 'modes' || getValueMappingKey(row) !== 'mode') return undefined
	return rows.find((candidate) => {
		const path = candidate.oscPath
		return path.startsWith(`/${section}/`) && path.includes('*') && path.endsWith('/name')
	})?.oscPath
}

export function getMappedValue(row: CommandRow, value: unknown, use: ValueMappingUse): string | undefined {
	if (typeof value !== 'number' && typeof value !== 'boolean') return undefined
	return getValueMapping(row, use)?.[String(Number(value))]
}

export function getMappedChoices(row: CommandRow): Array<{ id: number; label: string }> | undefined {
	const mapping = getValueMapping(row, 'action')
	if (!mapping) return undefined
	return Object.entries(mapping).map(([value, label]) => ({ id: Number(value), label }))
}
