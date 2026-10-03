import { readFileSync } from 'node:fs'
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
	return `[${formatWords(category!)}] ${name.map(formatWords).join('/') || formatWords(category!)}`
}

function csvPath(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), '../digico_osc.csv')
}

export function loadCommandTable(): CommandRow[] {
	const file = csvPath()
	const lines = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
	if (lines.length < 2) throw new Error(`DiGiCo OSC command table is empty: ${file}`)
	const headers = parseCsvLine(lines[0]!)
	const required = ['osc_path', 'data_type', 'osc_min', 'osc_max', 'rw', 'description', 'units', 'Scale']
	const columns = Object.fromEntries(required.map((name) => {
		const index = headers.indexOf(name)
		if (index < 0) throw new Error(`Missing "${name}" column in ${file}`)
		return [name, index]
	})) as Record<(typeof required)[number], number>
	const parseBound = (value: string | undefined): number | undefined =>
		value === undefined || value.trim() === '' || !Number.isFinite(Number(value)) ? undefined : Number(value)

	return lines.slice(1).map((line, index) => {
		const values = parseCsvLine(line)
		const get = (column: (typeof required)[number]) => values[columns[column]] ?? ''
		const oscPath = get('osc_path').trim()
		if (!oscPath) throw new Error(`Missing OSC path in command table row ${index + 2}`)
		const scale = Number(get('Scale'))
		if (!Number.isFinite(scale) || scale <= 0) {
			throw new Error(`Invalid Scale in command table row ${index + 2}: ${get('Scale')}`)
		}
		return {
			name: commandNameFromPath(oscPath),
			oscPath,
			dataType: get('data_type').trim(),
			min: parseBound(get('osc_min')),
			max: parseBound(get('osc_max')),
			rw: get('rw').trim().toUpperCase(),
			description: get('description').trim(),
			units: get('units').trim(),
			scale,
		}
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
		if (!segments[index]!.includes('*')) continue
		if (currentAxis++ === axis) return segments[index - 1]
	}
	return undefined
}

export function getPathAxisLabel(path: string, axis: number): string {
	const segment = getPathAxisSegment(path, axis)
	if (!segment) return `Path ${axis + 1}`
	const words = formatWords(segment).split(' ')
	const final = words.at(-1) ?? ''
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
