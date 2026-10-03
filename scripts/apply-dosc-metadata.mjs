import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const moduleCsvPath = resolve(process.argv[2] ?? 'digico_osc.csv')
const doscCsvPath = resolve(process.argv[3] ?? 'docs/IPAD_Q3.DOSC.parsed.csv')
const crosswalkPath = resolve(process.argv[4] ?? 'docs/dosc_csv_crosswalk.csv')
const auditPath = resolve('docs/dosc_value_updates.csv')

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
	return {
		header,
		rows: data.map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index] ?? '']))),
	}
}

function serializeCsv(rows) {
	return rows.map((row) => row.map((value) => {
		const text = String(value ?? '')
		return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
	}).join(',')).join('\n') + '\n'
}

function typeCompatible(typeCode, dataType) {
	if (typeCode === '0') return ['Int', 'BInt', 'BFloat', 'Float'].includes(dataType)
	if (typeCode === '1') return dataType === 'Float'
	if (typeCode === '4') return dataType === 'String'
	return false
}

function normalizedUnit(extensionText) {
	const text = extensionText.toLowerCase()
	if (text.includes('db')) return { unit: 'dB', scale: 1 }
	if (text.includes('khz') && text.includes('hz')) return { unit: 'Hz', scale: 1 }
	if (text.includes('ms') && text.includes('us')) return { unit: 'ms', scale: 1000 }
	if (text.includes('samples')) return { unit: 'samples', scale: 1 }
	if (text.includes(': 1')) return { unit: ':1', scale: 1 }
	return undefined
}

function formatNumber(value) {
	return Number(value.toPrecision(7)).toString()
}

function candidatePaths(candidateText) {
	return candidateText.split(' || ').flatMap((candidate) => {
		const match = candidate.match(/^(.+?) \[/)
		return match ? [match[1]] : []
	})
}

const moduleCsv = parseCsv(readFileSync(moduleCsvPath, 'utf8').replace(/^\uFEFF/u, ''))
const doscCsv = parseCsv(readFileSync(doscCsvPath, 'utf8').replace(/^\uFEFF/u, '')).rows
const crosswalkCsv = parseCsv(readFileSync(crosswalkPath, 'utf8').replace(/^\uFEFF/u, '')).rows
const rowsByPath = new Map(moduleCsv.rows.map((row) => [row.osc_path, row]))
const crosswalkByLabel = new Map(crosswalkCsv
	.filter((row) => row.source_file === 'IPAD_Q3.DOSC.parsed.csv')
	.map((row) => [row.record, row]))
const recordsByLabel = new Map()
for (const record of doscCsv) {
	const records = recordsByLabel.get(record.label) ?? []
	records.push(record)
	recordsByLabel.set(record.label, records)
}

const audit = [[
	'csv_path', 'dosc_label', 'dosc_records', 'match_basis', 'old_min', 'new_min', 'old_max', 'new_max',
	'old_units', 'new_units',
]]
const changedPaths = new Set()

for (const [label, records] of recordsByLabel) {
	if (label.toLowerCase() === 'phase') continue
	const first = records[0]
	if (!['0', '1'].includes(first.type_code)) continue
	if (records.length !== Number(first.record ? crosswalkByLabel.get(first.record)?.label_occurrences : 0)) continue
	if (records.some((record) => record.type_code !== first.type_code || record.min_value !== first.min_value || record.max_value !== first.max_value || record.extension_text !== first.extension_text)) continue
	if (first.min_value === '0' && first.max_value === '0') continue

	const crosswalkRecord = crosswalkByLabel.get(first.record)
	if (!crosswalkRecord) continue
	const possiblePaths = candidatePaths(crosswalkRecord.candidates)
	const uniquePaths = [...new Set(possiblePaths)]
	const compatiblePaths = uniquePaths.filter((path) => {
		const row = rowsByPath.get(path)
		return row && !path.startsWith('/Console/') && typeCompatible(first.type_code, row.data_type)
	})
	if (compatiblePaths.length !== records.length) continue

	const recordIndexes = records.map((record) => record.record)
	const unit = normalizedUnit(first.extension_text)
	const minValue = first.min_value === '' ? undefined : Number(first.min_value) * (unit?.scale ?? 1)
	const maxValue = first.max_value === '' ? undefined : Number(first.max_value) * (unit?.scale ?? 1)
	if ((minValue !== undefined && !Number.isFinite(minValue)) || (maxValue !== undefined && !Number.isFinite(maxValue))) continue
	const matchBasis = records.length === 1 ? 'unique type-compatible candidate' : 'label occurrence count equals type-compatible candidates'

	for (const path of compatiblePaths) {
		const row = rowsByPath.get(path)
		const old = { min: row.osc_min, max: row.osc_max, units: row.units }
		if (minValue !== undefined) row.osc_min = formatNumber(minValue)
		if (maxValue !== undefined) row.osc_max = formatNumber(maxValue)
		if (unit) row.units = unit.unit
		if (old.min === row.osc_min && old.max === row.osc_max && old.units === row.units) continue
		changedPaths.add(path)
		audit.push([
			path, label, recordIndexes.join(';'), matchBasis,
			old.min, row.osc_min, old.max, row.osc_max, old.units, row.units,
		])
	}
}

writeFileSync(moduleCsvPath, serializeCsv([moduleCsv.header, ...moduleCsv.rows.map((row) => moduleCsv.header.map((key) => row[key] ?? ''))]), 'utf8')
writeFileSync(auditPath, serializeCsv(audit), 'utf8')
console.log(`Module rows updated: ${changedPaths.size}`)
console.log(`Updated values logged: ${audit.length - 1}`)
console.log(`Audit written: ${auditPath}`)
