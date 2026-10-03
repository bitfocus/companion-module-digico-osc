import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type CommandRow = {
	name: string
	oscPath: string
	parameterKey: string
	dataType: string
	min: number | undefined
	max: number | undefined
	units: string
	rw: string
	description: string
	valueFeedback: string
}

export function isBooleanDataType(dataType: string): boolean {
	return dataType === 'BInt' || dataType === 'BFloat'
}

export function oscDataType(dataType: string): string {
	if (dataType === 'BInt') return 'Int'
	if (dataType === 'BFloat') return 'Float'
	return dataType
}

function parseCsvLine(line: string): string[] {
	const result: string[] = []
	let value = ''
	let quoted = false
	for (let i = 0; i < line.length; i++) {
		const char = line[i]
		if (char === '"') {
			if (quoted && line[i + 1] === '"') {
				value += '"'
				i++
			} else {
				quoted = !quoted
			}
		} else if (char === ',' && !quoted) {
			result.push(value)
			value = ''
		} else {
			value += char
		}
	}
	result.push(value)
	return result
}

function csvFilePath(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), '../digico_osc.csv')
}

export function loadCommandTable(): CommandRow[] {
	const csvPath = csvFilePath()
	const lines = readFileSync(csvPath, 'utf8')
		.replace(/^\uFEFF/, '')
		.split(/\r?\n/)
		.filter(Boolean)
	if (lines.length < 2) throw new Error(`DiGiCo OSC command table is empty: ${csvPath}`)

	const headers = parseCsvLine(lines[0])
	const column = (name: string) => {
		const index = headers.indexOf(name)
		if (index < 0) throw new Error(`Missing "${name}" column in ${csvPath}`)
		return index
	}
	const columns = {
		name: column('name'),
		oscPath: column('osc_path'),
		dataType: column('data_type'),
		min: column('osc_min'),
		max: column('osc_max'),
		units: column('units'),
		rw: column('rw'),
		description: column('description'),
		valueFeedback: headers.indexOf('value_feedback'),
	}

	return lines.slice(1).map((line, index) => {
		const values = parseCsvLine(line)
		const get = (key: Exclude<keyof typeof columns, 'valueFeedback'>) => values[columns[key]] ?? ''
		const parseBound = (key: 'min' | 'max'): number | undefined => {
			const value = get(key)
			return value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value)
		}
		const row: CommandRow = {
			name: get('name'),
			oscPath: get('oscPath'),
			parameterKey: deriveParameterKey(get('oscPath')),
			dataType: get('dataType'),
			min: parseBound('min'),
			max: parseBound('max'),
			units: get('units'),
			rw: get('rw'),
			description: get('description'),
			valueFeedback: columns.valueFeedback >= 0 ? values[columns.valueFeedback] ?? '' : '',
		}
		if (!row.name || !row.oscPath) throw new Error(`Invalid DiGiCo OSC command row ${index + 2}`)
		return row
	})
}

function deriveParameterKey(path: string): string {
	const segments = path.split('/').filter(Boolean)
	let key = segments.at(-1) ?? ''
	if (key === '*') key = segments.at(-2) ?? ''
	return key
}

export function isReadable(row: CommandRow): boolean {
	return row.rw.includes('R')
}

export function isWritable(row: CommandRow): boolean {
	return row.rw.includes('W')
}

export function getPathParameterCount(path: string): number {
	return (path.match(/\*/g) ?? []).length
}

export function getPathParameterDefault(path: string, axis: number): number {
	const segments = path.split('/').filter(Boolean)
	if (segments.some((segment) => /snapshot|preset|macro/i.test(segment))) return 0
	const wildcardIndex = path.split('/').flatMap((segment, index) => (segment.includes('*') ? [index] : []))[axis]
	if (wildcardIndex === undefined) return 1
	const selector = path.split('/')[wildcardIndex - 1]?.toLowerCase() ?? ''
	return selector.includes('snapshot') || selector.includes('preset') || selector === 'recall_macro' ? 0 : 1
}

export function getPathAxisLabel(path: string, axis: number): string {
	const segments = path.split('/')
	const wildcardIndexes = segments.flatMap((segment, index) => (segment.includes('*') ? [index] : []))
	const segment = segments[wildcardIndexes[axis]! - 1] ?? `Path ${axis + 1}`
	const words = segment.replace(/_/g, ' ').split(/\s+/).filter(Boolean)
	const last = words.at(-1)
	if (last) {
		if (last.endsWith('ies')) words[words.length - 1] = `${last.slice(0, -3)}y`
		else if (last.endsWith('s') && !/(ss|us|is)$/.test(last)) words[words.length - 1] = last.slice(0, -1)
	}
	return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

const parameterKeyAliases: Record<string, string> = {
	new_snapshot: 'snapshot',
	change_surface_snapshot: 'snapshot',
	recall_snapshot: 'snapshot',
	rename_snapshot: 'snapshot',
	renumber_snapshot: 'snapshot',
	delete_snapshot: 'snapshot',
	update_snapshot: 'snapshot',
	delete_preset: 'presets',
	lock_preset: 'presets',
	recall_preset: 'presets',
	rename_preset: 'presets',
	rename_preset_group: 'presets',
	update_preset: 'presets',
}

const knownParameterKeys = new Set([
	'input_channels',
	'aux_outputs',
	'group_outputs',
	'talkback_outputs',
	'matrix_inputs',
	'matrix_outputs',
	'control_groups',
	'graphic_eq',
	'multis',
	'aux_send',
	'group_send',
	'matrix_send',
	'recall_macro',
	'presets',
	'snapshot',
])

export function getPathParameterKey(path: string, axis: number): string | undefined {
	const segments = path.split('/')
	const wildcardIndexes = segments.flatMap((segment, index) => (segment.includes('*') ? [index] : []))
	const segment = segments[wildcardIndexes[axis]! - 1]
	if (!segment) return undefined

	const normalized = segment.toLowerCase()
	const key = parameterKeyAliases[normalized] ?? normalized
	return knownParameterKeys.has(key) ? key : undefined
}

export function getPathOptionNameTemplate(path: string, axis: number): string | undefined {
	const segments = path.split('/')
	const wildcardIndex = segments.flatMap((segment, index) => (segment.includes('*') ? [index] : []))[axis]
	if (wildcardIndex === undefined) return undefined
	const segment = segments[wildcardIndex - 1]
	if (segment === 'Input_Channels') return '/Input_Channels/*/Channel_Input/name'
	if (segment === 'Aux_Outputs' || segment === 'Aux_Send') return '/Aux_Outputs/*/Buss_Trim/name'
	if (segment === 'Group_Outputs' || segment === 'Group_Send') return '/Group_Outputs/*/Buss_Trim/name'
	if (segment === 'Control_Groups') return '/Control_Groups/*/name'
	if (segment === 'Matrix_Outputs' || segment === 'Matrix_Send') return '/Matrix_Outputs/*/Buss_Trim/name'
	return undefined
}

export function materializePath(template: string, indexes: number[]): string {
	let index = 0
	return template.replace(/\*/g, () => String(indexes[index++] ?? 1))
}

const pathMatcherCache = new Map<string, RegExp>()

export function pathMatcher(template: string): RegExp {
	const cached = pathMatcherCache.get(template)
	if (cached) return cached
	const escaped = template.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
	const matcher = new RegExp(`^${escaped.join('([^/]+)')}$`)
	pathMatcherCache.set(template, matcher)
	return matcher
}
