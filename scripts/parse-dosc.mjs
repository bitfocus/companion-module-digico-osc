import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const input = resolve(process.argv[2] ?? 'IPADV2sd8-9-11-12.dosc')
const output = resolve(process.argv[3] ?? `${input}.parsed.csv`)
const bytes = readFileSync(input)

const headerLength = bytes.readUInt16LE(0)
const header = bytes
	.subarray(2, 2 + headerLength)
	.toString('utf8')
	.replace(/\0+$/, '')
	.trim()
const entries = []

for (let offset = 0; offset + 3 < bytes.length; offset++) {
	if (bytes[offset] !== 1 || bytes[offset + 1] !== 0) continue
	const nameLength = bytes[offset + 2]
	if (nameLength === 0 || nameLength >= 80 || offset + 3 + nameLength > bytes.length) continue
	const labelBytes = bytes.subarray(offset + 3, offset + 3 + nameLength)
	if (![...labelBytes].every((byte) => byte >= 0x20 && byte <= 0x7e)) continue

	const recordStart = offset - 27
	if (recordStart < 2 + headerLength || recordStart + 64 > bytes.length) continue
	entries.push({ recordStart, label: labelBytes.toString('ascii') })
	offset += nameLength + 2
}

function csvCell(value) {
	const text = String(value ?? '')
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function printableRuns(data) {
	const runs = []
	let start = -1
	for (let index = 0; index <= data.length; index++) {
		const byte = data[index]
		if (byte !== undefined && byte >= 0x20 && byte <= 0x7e) {
			if (start < 0) start = index
		} else if (start >= 0) {
			if (index - start >= 2) runs.push(data.subarray(start, index).toString('ascii'))
			start = -1
		}
	}
	return [...new Set(runs)]
}

const rows = entries.map((entry, index) => {
	const nextStart = entries[index + 1]?.recordStart ?? bytes.length
	const core = bytes.subarray(entry.recordStart, entry.recordStart + 64)
	const extension = bytes.subarray(entry.recordStart + 64, nextStart)
	const min = core.readFloatLE(11)
	const max = core.readFloatLE(15)
	const typeCode = core[10]
	const typeHint = { 0: 'Discrete (integer/enum)', 1: 'Float', 3: 'Meter', 4: 'String' }[typeCode] ?? 'Unknown'
	return [
		index + 1,
		entry.label,
		typeCode,
		typeHint,
		Number.isFinite(min) ? min : '',
		Number.isFinite(max) ? max : '',
		printableRuns(extension).join(' | '),
		core.subarray(0, 11).toString('hex'),
		extension.length,
	]
})

const columns = [
	'record',
	'label',
	'type_code',
	'type_hint',
	'min_value',
	'max_value',
	'extension_text',
	'raw_header_hex',
	'extension_bytes',
]
writeFileSync(output, [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n')

const declaredCount = Number(header.match(/(\d+)\s*$/)?.[1])
const labels = new Set(entries.map(({ label }) => label))
const textRuns = new Map()
for (const row of rows) {
	for (const item of String(row[6]).split(' | ').filter(Boolean)) textRuns.set(item, (textRuns.get(item) ?? 0) + 1)
}

console.log(`File: ${basename(input)}`)
console.log(`Header: ${header}`)
console.log(`Header-declared command count: ${Number.isFinite(declaredCount) ? declaredCount : 'not found'}`)
console.log(`Decoded labeled records: ${entries.length}`)
console.log(`Distinct labels: ${labels.size}`)
console.log(
	`Type code counts: ${JSON.stringify(Object.fromEntries([...new Set(rows.map((row) => row[2]))].map((code) => [code, rows.filter((row) => row[2] === code).length])))}`,
)
console.log(`CSV written: ${output}`)
console.log(`Extension text found: ${[...textRuns.keys()].join(', ') || '(none)'}`)
