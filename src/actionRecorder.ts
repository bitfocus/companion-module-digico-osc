import type { CompanionRecordedAction, JsonValue } from '@companion-module/base'
import type { CommandRow } from './commandTable.js'
import { getPathParameterCount, pathMatcher } from './commandTable.js'
import type { OSCValue } from './osc.js'

export class IncomingActionRecorder {
	private recording = false
	private readonly recordedValues = new Map<string, string>()

	constructor(private readonly recordAction: (action: CompanionRecordedAction, uniqueId: string) => void) {}

	setRecording(recording: boolean): void {
		this.recording = recording
		this.recordedValues.clear()
	}

	record(path: string, args: OSCValue[], rows: CommandRow[]): void {
		if (!this.recording || args.length === 0) return

		for (const row of rows) {
			if (!row.rw.includes('W')) continue
			const match = path.match(pathMatcher(row.oscPath))
			if (!match) continue

			const isFixedValue = row.parameterKey === 'Recall_Macro' || row.parameterKey === 'New_Snapshot' || row.parameterKey === 'Recall_Snapshot'
			const options: Record<string, JsonValue> = {}
			for (let axis = 0; axis < getPathParameterCount(row.oscPath); axis++) {
				let index = Number(match[axis + 1])
				if (!Number.isInteger(index)) continue
				options[`index_${axis + 1}`] = [index]
			}
			if (!isFixedValue) {
				const value = args[0]
				if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') continue
				options.value = typeof value === 'boolean' ? Number(value) : value
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
