import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const moduleCsvPath = resolve(process.argv[2] ?? 'digico_osc.csv')
const parsedFiles = process.argv.slice(3).length > 0
	? process.argv.slice(3).map((path) => resolve(path))
	: [
		resolve('docs/IPAD_Q3.DOSC.parsed.csv'),
		resolve('docs/IPADV2sd8-9-11-12.dosc.parsed.csv'),
	]
const outputPath = resolve('docs/dosc_csv_crosswalk.csv')

function parseCsv(text) {
	const rows = []
	let row = []
	let value = ''
	let quoted = false
	for (let index = 0; index < text.length; index++) {
		const char = text[index]
		if (char === '"') {
			if (quoted && text[index + 1] === '"') {
				value += '"'
				index++
			} else {
				quoted = !quoted
			}
		} else if (char === ',' && !quoted) {
			row.push(value)
			value = ''
		} else if ((char === '\n' || char === '\r') && !quoted) {
			if (char === '\r' && text[index + 1] === '\n') index++
			row.push(value)
			if (row.some((cell) => cell !== '')) rows.push(row)
			row = []
			value = ''
		} else {
			value += char
		}
	}
	if (value !== '' || row.length > 0) {
		row.push(value)
		if (row.some((cell) => cell !== '')) rows.push(row)
	}
	const [header, ...data] = rows
	return data.map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ''])))
}

function serializeCsv(rows) {
	return rows.map((row) => row.map((value) => {
		const text = String(value ?? '')
		return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
	}).join(',')).join('\n') + '\n'
}

function normalizedPart(value) {
	return value.toLowerCase().replace(/[^a-z0-9*]/g, '')
}

function normalizedLabel(value) {
	return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function numericEqual(first, second) {
	if (first === '' || second === '') return false
	const a = Number(first)
	const b = Number(second)
	return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * 1e-6)
}

function typeCompatible(code, dataType) {
	if (code === '0') return ['Int', 'BInt', 'BFloat', 'Float'].includes(dataType)
	if (code === '1' || code === '3') return dataType === 'Float'
	if (code === '4') return dataType === 'String'
	return false
}

function rangeComparison(record, command) {
	const hasRecordBounds = record.min_value !== '' || record.max_value !== ''
	const hasCommandBounds = command.osc_min !== '' || command.osc_max !== ''
	if (!hasRecordBounds && !hasCommandBounds) return 'no numeric bounds'
	const matchingMin = numericEqual(record.min_value, command.osc_min)
	const matchingMax = numericEqual(record.max_value, command.osc_max)
	if (matchingMin && matchingMax) return 'range agrees'
	if (matchingMin || matchingMax) return 'one bound agrees'
	return 'range differs'
}

function explicitPaths(extensionText) {
	return extensionText.split(' | ').map((text) => text.trim())
		.filter((text) => text.includes('/') && !/^\/+$/u.test(text))
		.map((text) => text.replace(/\/$/u, '').replace(/\/?\?$/u, '').split('/').filter(Boolean))
}

const moduleRows = parseCsv(readFileSync(moduleCsvPath, 'utf8').replace(/^\uFEFF/u, ''))
const commandRows = moduleRows.map((row) => ({
	...row,
	pathParts: row.osc_path.split('/').filter(Boolean).map(normalizedPart),
	pathLabel: normalizedLabel(row.osc_path.split('/').filter(Boolean).at(-1) ?? ''),
}))

const output = [[
	'source_file', 'record', 'label_occurrence', 'label_occurrences', 'previous_record_label', 'label', 'next_record_label',
	'type_code', 'type_hint', 'min_value', 'max_value', 'extension_text', 'raw_header_hex',
	'match_status', 'candidate_count', 'candidates', 'review_notes',
]]

for (const parsedFile of parsedFiles) {
	const doscRows = parseCsv(readFileSync(parsedFile, 'utf8').replace(/^\uFEFF/u, ''))
	const labelCounts = new Map()
	for (const record of doscRows) {
		const key = normalizedLabel(record.label)
		labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1)
	}
	const labelOccurrences = new Map()
	for (let recordIndex = 0; recordIndex < doscRows.length; recordIndex++) {
		const record = doscRows[recordIndex]
		const labelParts = record.label.split('/').filter(Boolean).map(normalizedPart)
		const labelKey = normalizedLabel(record.label)
		const labelOccurrence = (labelOccurrences.get(labelKey) ?? 0) + 1
		labelOccurrences.set(labelKey, labelOccurrence)
		const embeddedPaths = explicitPaths(record.extension_text).map((parts) => parts.map(normalizedPart))
		const candidates = new Map()

		for (const command of commandRows) {
			const labelMatch = command.pathLabel === labelKey || (
				labelParts.length > 1 &&
				command.pathParts.slice(-labelParts.length).join('/') === labelParts.join('/')
			)
			const pathMatch = embeddedPaths.some((pathParts) => {
				return command.pathParts.slice(-pathParts.length).join('/') === pathParts.join('/')
			})
			if (!labelMatch && !pathMatch) continue

			const compatibleType = typeCompatible(record.type_code, command.data_type)
			const rangeStatus = rangeComparison(record, command)
			const candidateNotes = [
				pathMatch ? 'embedded path' : 'label suffix',
				compatibleType ? 'type compatible' : 'type differs',
				rangeStatus,
			].join('; ')
			candidates.set(command.osc_path, {
				path: command.osc_path,
				dataType: command.data_type,
				min: command.osc_min,
				max: command.osc_max,
				units: command.units,
				pathMatch,
				notes: candidateNotes,
			})
		}

		const candidateList = [...candidates.values()].sort((a, b) => Number(b.pathMatch) - Number(a.pathMatch) || a.path.localeCompare(b.path))
		const directCount = candidateList.filter((candidate) => candidate.pathMatch).length
		const status = directCount > 0
			? directCount === 1 ? 'embedded_path_match' : 'embedded_path_ambiguous'
			: candidateList.length === 1 ? 'unique_label_candidate'
				: candidateList.length > 1 ? 'ambiguous_label_candidates' : 'unmatched'
		const formattedCandidates = candidateList.map((candidate) => {
			const range = candidate.min === '' && candidate.max === '' ? 'no range' : `${candidate.min || '?'}..${candidate.max || '?'}`
			const units = candidate.units ? ` ${candidate.units}` : ''
			return `${candidate.path} [${candidate.dataType}; ${range}${units}; ${candidate.notes}]`
		}).join(' || ')
		const reviewNotes = status === 'embedded_path_match'
			? 'Strongest match signal; verify before copying values.'
			: status === 'unique_label_candidate'
				? 'Only one path has this label, but section context is not decoded.'
				: status === 'ambiguous_label_candidates'
					? 'Choose the matching path using console section/context.'
					: status === 'embedded_path_ambiguous'
						? 'Embedded path text maps to multiple rows; review candidate details.'
						: 'No candidate path found by label or embedded path text.'

		output.push([
			parsedFile.split('/').at(-1), record.record, labelOccurrence, labelCounts.get(labelKey),
			doscRows[recordIndex - 1]?.label ?? '', record.label, doscRows[recordIndex + 1]?.label ?? '',
			record.type_code, record.type_hint,
			record.min_value, record.max_value, record.extension_text, record.raw_header_hex,
			status, candidateList.length, formattedCandidates, reviewNotes,
		])
	}
}

writeFileSync(outputPath, serializeCsv(output), 'utf8')
console.log(`Module commands: ${commandRows.length}`)
console.log(`DOSC records cross-referenced: ${output.length - 1}`)
console.log(`Crosswalk written: ${outputPath}`)
