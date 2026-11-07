import type { CompanionRecordedAction, JsonValue } from '@companion-module/base'
import type { CommandRow } from './commandTable.js'
import { getPathParameterCount, isNoArgs, pathMatcher } from './commandTable.js'
import { hasEntityRoot } from './entityRecords.js'
import type { OSCValue } from './osc.js'
import { getValueSelectorPath } from './valueMappings.js'

export class IncomingActionRecorder {
	private recording = false
	private readonly recordedValues = new Map<string, string>()

	constructor(private readonly recordAction: (action: CompanionRecordedAction, uniqueId: string) => void) {}

	setRecording(recording: boolean): void {
		this.recording = recording
		this.recordedValues.clear()
	}

	record(path: string, args: OSCValue[], rows: CommandRow[]): void {
		if (!this.recording) return

		for (const row of rows) {
			if (!row.rw.includes('W')) continue
			if (row.oscPath.startsWith('/Presets/')) continue
			if (getValueSelectorPath(row, rows)) continue
			const match = path.match(pathMatcher(row.oscPath))
			if (!match) continue

			const options: Record<string, JsonValue> = {}
			for (let axis = 0; axis < getPathParameterCount(row.oscPath); axis++) {
				const index = Number(match[axis + 1])
				if (!Number.isInteger(index)) continue
				const root = row.oscPath.split('/').filter(Boolean)[0]
				options[`index_${axis + 1}`] = root && hasEntityRoot(root) ? index : [index]
			}
			if (!isNoArgs(row) && args.length > 0) {
				const value = args[0]
				if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') continue
				options.value =
					typeof value === 'boolean' ? Number(value) : typeof value === 'number' ? value * row.scale : value
			}

			const action: CompanionRecordedAction = { actionId: row.oscPath, options }
			const uniqueId = `digico:${row.oscPath}:${path}`
			const signature = JSON.stringify(options)
			if (this.recordedValues.get(uniqueId) === signature) continue
			this.recordedValues.set(uniqueId, signature)
			this.recordAction(action, uniqueId)
		}
	}
}
