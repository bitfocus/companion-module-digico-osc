import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type CommandRow = {
	name: string
	oscPath: string
	dataType: string
	min: number | undefined
	max: number | undefined
	rw: string
	description: string
	units: string
	scale: number
	feedbackSchema: string
	feedbackName: string
	feedbackSelectorLabel: string
	booleanFeedbackName: string
	booleanFeedbackDescription: string
	booleanFeedbackId: string
	booleanFeedbackStateField: string
	booleanFeedbackStateLabel: string
	booleanFeedbackOnValue: number | undefined
	booleanFeedbackOffValue: number | undefined
	legacyFeedbackIds: string[]
	valueSelectorLabel: string
	valueSelectorSource: string
	feedbackValueAsBoolean: boolean
	learnSchema: string
}

function parseCsvLine(line: string): string[] {
	const values: string[] = []
	let value = ''
	let quoted = false
	for (let index = 0; index < line.length; index++) {
		const char = line[index]
		if (char === '"') {
			if (quoted && line[index + 1] === '"') {
				value += '"'
				index++
			} else {
				quoted = !quoted
			}
		} else if (char === ',' && !quoted) {
			values.push(value)
			value = ''
		} else {
			value += char
		}
	}
	values.push(value)
	return values
}

function formatWords(value: string): string {
	return value
		.replace(/[_-]+/g, ' ')
		.trim()
		.split(/\s+/)
		.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
		.join(' ')
}

export function commandNameFromPath(path: string): string {
	const segments = path.split('/').filter((segment) => segment && segment !== '*')
	if (segments.length === 0) return '[DiGiCo] Command'
	const [category, ...name] = segments
	return `[${formatWords(category)}] ${name.map(formatWords).join('/') || formatWords(category)}`
}

export function getPathEndpoint(path: string): string {
	return (
		path
			.split('/')
			.filter((segment) => segment && segment !== '*')
			.at(-1) ?? ''
	)
}

function valueSelectorLabelFromPath(path: string): string {
	const endpoint = getPathEndpoint(path)
	return endpoint.startsWith('Move_') ? `To ${formatWords(endpoint.slice('Move_'.length))}` : ''
}

function learnSchemaFromPath(path: string): string {
	const endpoint = getPathEndpoint(path)
	if (endpoint === 'Rename_Preset_Group') return 'group'
	return endpoint.startsWith('Rename_') ? 'name' : ''
}

function csvPath(name: string): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url))
	const paths = [resolve(moduleDir, name), resolve(moduleDir, `../${name}`)]
	return paths.find((path) => existsSync(path)) ?? paths[0]
}

export function loadCommandTable(): CommandRow[] {
	const required = ['osc_path', 'data_type', 'osc_min', 'osc_max', 'rw', 'description', 'units', 'Scale']
	const dataTypes = ['Int', 'Float', 'String', 'BInt', 'BFloat']
	const parseBound = (value: string | undefined): number | undefined =>
		value === undefined || value.trim() === '' || !Number.isFinite(Number(value)) ? undefined : Number(value)
	const parseDataType = (value: string, file: string, row: number): string => {
		const rawType = value.trim()
		if (!rawType) return ''
		const dataType = dataTypes.find((type) => type.toLowerCase() === rawType.toLowerCase())
		if (!dataType) throw new Error(`Invalid data_type in ${file}, row ${row}: ${rawType}`)
		return dataType
	}

	return ['digico_osc.csv', 'digico_entities.csv'].flatMap((filename) => {
		const file = csvPath(filename)
		const lines = readFileSync(file, 'utf8')
			.replace(/^\uFEFF/, '')
			.split(/\r?\n/)
			.filter(Boolean)
		if (lines.length < 2) throw new Error(`DiGiCo OSC command table is empty: ${file}`)
		const headers = parseCsvLine(lines[0])
		const columns = Object.fromEntries(
			[
				...required,
				'feedback_schema',
				'feedback_name',
				'display_name',
				'feedback_selector_label',
				'boolean_feedback_name',
				'boolean_feedback_description',
				'boolean_feedback_id',
				'boolean_feedback_state_field',
				'boolean_feedback_state_label',
				'boolean_feedback_on_value',
				'boolean_feedback_off_value',
				'legacy_feedback_ids',
				'value_selector_label',
				'value_selector_source',
				'feedback_value_as_boolean',
			].map((name) => {
				const index = headers.indexOf(name)
				if (required.includes(name) && index < 0) throw new Error(`Missing "${name}" column in ${file}`)
				return [name, index]
			}),
		) as Record<
			| (typeof required)[number]
			| 'feedback_schema'
			| 'feedback_name'
			| 'display_name'
			| 'feedback_selector_label'
			| 'boolean_feedback_name'
			| 'boolean_feedback_description'
			| 'boolean_feedback_id'
			| 'boolean_feedback_state_field'
			| 'boolean_feedback_state_label'
			| 'boolean_feedback_on_value'
			| 'boolean_feedback_off_value'
			| 'legacy_feedback_ids'
			| 'value_selector_label'
			| 'value_selector_source'
			| 'feedback_value_as_boolean',
			number
		>
		return lines.slice(1).map((line, index) => {
			const values = parseCsvLine(line)
			const get = (column: keyof typeof columns) => (columns[column] < 0 ? '' : (values[columns[column]] ?? ''))
			const oscPath = get('osc_path').trim()
			if (!oscPath) throw new Error(`Missing OSC path in ${file}, row ${index + 2}`)
			const scale = Number(get('Scale'))
			if (!Number.isFinite(scale) || scale <= 0) {
				throw new Error(`Invalid Scale in ${file}, row ${index + 2}: ${get('Scale')}`)
			}
			return {
				name: get('display_name').trim() || commandNameFromPath(oscPath),
				oscPath,
				dataType: parseDataType(get('data_type'), file, index + 2),
				min: parseBound(get('osc_min')),
				max: parseBound(get('osc_max')),
				rw: get('rw').trim().toUpperCase(),
				description: get('description').trim(),
				units: get('units').trim(),
				scale,
				feedbackSchema: get('feedback_schema').trim(),
				feedbackName: get('feedback_name').trim(),
				feedbackSelectorLabel: get('feedback_selector_label').trim(),
				booleanFeedbackName: get('boolean_feedback_name').trim(),
				booleanFeedbackDescription: get('boolean_feedback_description').trim(),
				booleanFeedbackId: get('boolean_feedback_id').trim(),
				booleanFeedbackStateField: get('boolean_feedback_state_field').trim(),
				booleanFeedbackStateLabel: get('boolean_feedback_state_label').trim(),
				booleanFeedbackOnValue: parseBound(get('boolean_feedback_on_value')),
				booleanFeedbackOffValue: parseBound(get('boolean_feedback_off_value')),
				legacyFeedbackIds: get('legacy_feedback_ids')
					.split(';')
					.map((id) => id.trim())
					.filter(Boolean),
				valueSelectorLabel: get('value_selector_label').trim() || valueSelectorLabelFromPath(oscPath),
				valueSelectorSource: get('value_selector_source').trim(),
				feedbackValueAsBoolean: get('feedback_value_as_boolean').trim().toLowerCase() === 'true',
				learnSchema: learnSchemaFromPath(oscPath),
			}
		})
	})
}

export function isNoArgs(row: CommandRow): boolean {
	return !row.dataType
}

export function isBooleanDataType(dataType: string): boolean {
	return dataType === 'BInt' || dataType === 'BFloat'
}

export function oscDataType(dataType: string): 'Int' | 'Float' | 'String' | undefined {
	return (['Int', 'Float', 'String'] as const).find((type) => type === dataType.replace(/^B/, ''))
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

export function getPathAxisSegment(path: string, axis: number): string | undefined {
	const segments = path.split('/').filter(Boolean)
	let currentAxis = 0
	for (let index = 0; index < segments.length; index++) {
		if (!segments[index].includes('*')) continue
		if (currentAxis++ === axis) return segments[index - 1]
	}
	return undefined
}

export function getPathAxisLabel(path: string, axis: number): string {
	const segment = getPathAxisSegment(path, axis)
	if (!segment) return `Path ${axis + 1}`
	const words = formatWords(segment).split(' ')
	const final = words[words.length - 1] ?? ''
	if (final.endsWith('ies')) words[words.length - 1] = `${final.slice(0, -3)}y`
	else if (final.endsWith('s') && !/(ss|us|is)$/i.test(final)) words[words.length - 1] = final.slice(0, -1)
	return words.join(' ')
}

export function materializePath(template: string, indexes: number[]): string {
	let axis = 0
	return template.replace(/\*/g, () => String(indexes[axis++] ?? 1))
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
