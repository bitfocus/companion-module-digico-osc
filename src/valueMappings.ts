import valueMappingsJson from './value-mappings.json' with { type: 'json' }
import type { CommandRow } from './commandTable.js'
import { isBooleanDataType } from './commandTable.js'

export type ValueMappingUse = 'action' | 'feedback'
type MappingValues = Record<string, string>
type ValueMapping = Partial<Record<ValueMappingUse, MappingValues>> & { selectorPaths?: Record<string, string> }

const valueMappings = valueMappingsJson as Record<string, ValueMapping>

export function getValueMappingKey(row: CommandRow): string | undefined {
	if (isBooleanDataType(row.dataType) || (row.dataType === 'Int' && row.min === 0 && row.max === 1)) return 'boolean'
	if (row.parameterKey === 'modes' || row.parameterKey === 'stereo_mode') return 'mode'
	if (valueMappings[row.parameterKey]) return row.parameterKey
	const lowercaseKey = row.parameterKey.toLowerCase()
	if (valueMappings[lowercaseKey]) return lowercaseKey
	const numberedBase = row.parameterKey.replace(/_\d+$/, '')
	return valueMappings[numberedBase] ? numberedBase : undefined
}

export function getValueMapping(row: CommandRow, use: ValueMappingUse): MappingValues | undefined {
	const key = getValueMappingKey(row)
	return key ? valueMappings[key]?.[use] : undefined
}

export function getValueSelectorPath(row: CommandRow): string | undefined {
	const key = getValueMappingKey(row)
	return key ? valueMappings[key]?.selectorPaths?.[row.oscPath] : undefined
}

export function getMappedValue(row: CommandRow, value: unknown, use: ValueMappingUse): string | undefined {
	if (typeof value !== 'number' && typeof value !== 'boolean') return undefined
	const mapping = getValueMapping(row, use)
	return mapping?.[String(Number(value))]
}

export function getMappedChoices(row: CommandRow): Array<{ id: number; label: string }> | undefined {
	const mapping = getValueMapping(row, 'action')
	if (!mapping) return undefined
	return Object.entries(mapping).map(([value, label]) => ({ id: Number(value), label }))
}
