import type {
	CompanionFeedbackDefinitions,
	CompanionFeedbackValueEvent,
	CompanionOptionValues,
	JsonValue,
	SomeCompanionFeedbackInputField,
} from '@companion-module/base'
import { createModuleLogger } from '@companion-module/base'
import specialFeedbacksJson from './special-feedbacks.json' with { type: 'json' }
import type ModuleInstance from './main.js'
import type { CommandRow } from './commandTable.js'
import { getPathAxisLabel, getPathParameterCount, getPathParameterDefault, isReadable, materializePath } from './commandTable.js'
import { getMappedValue, getValueSelectorPath } from './valueMappings.js'

const logger = createModuleLogger('feedback')

export type FeedbackOptions = CompanionOptionValues
export type FeedbacksSchema = Record<string, { type: 'value'; options: FeedbackOptions }>

type SpecialFeedbackSource = 'snapshot_note' | 'macro_state' | 'macro_name'
type SpecialFeedbackDefinition = {
	outputs: Array<{ suffix?: string; name: string; source: SpecialFeedbackSource; indexOption: string }>
}

const specialFeedbacks = specialFeedbacksJson as Record<string, SpecialFeedbackDefinition>

function specialFeedbackValue(self: ModuleInstance, source: SpecialFeedbackSource, index: number): JsonValue {
	switch (source) {
		case 'snapshot_note': return self.getSnapshotNote(index) ?? null
		case 'macro_state': return self.getMacroButtonState(index) ?? null
		case 'macro_name': return self.getMacroButtonName(index) ?? null
	}
}

function commandGroup(name: string): string {
	return name.match(/^\[([^\]]+)\]/)?.[1] ?? 'DiGiCo'
}

function optionLabel(id: string): string {
	return id.replace(/_/g, ' ').replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}

export function UpdateFeedbacks(self: ModuleInstance, rows: CommandRow[]): void {
	const feedbacks: CompanionFeedbackDefinitions<FeedbacksSchema> = {}
	rows.forEach((row) => {
		if (!isReadable(row)) return
		if (row.valueFeedback === 'json_by_index') {
			const choices = self.getNamedValueChoices(row.oscPath)
			const feedbackId = row.oscPath
			feedbacks[feedbackId] = {
				name: row.name,
				description: row.description,
				type: 'value',
				options: [{
					id: 'index',
					type: 'dropdown',
					label: 'Item',
					choices: choices.length > 0 ? choices : [{ id: 0, label: '0' }],
					default: 0,
				}],
				unsubscribe: (feedback) => self.releaseFeedbackValue(feedback.id),
				callback: (feedback: CompanionFeedbackValueEvent<FeedbackOptions>) => {
					const index = Math.max(0, Math.trunc(Number(feedback.options.index ?? 0)))
					self.watchFeedbackValue(feedback.id, row.oscPath, row.oscPath, index)
					return self.getNamedValue(row.oscPath, index) ?? null
				},
			}
			return
		}
		const specialDefinition = specialFeedbacks[row.oscPath]
		if (specialDefinition) {
			for (const output of specialDefinition.outputs) {
				const feedbackId = `${row.oscPath}${output.suffix ?? ''}`
				const macroSelector = output.source.startsWith('macro_')
				const defaultIndex = getPathParameterDefault(row.oscPath, 0)
				const options: SomeCompanionFeedbackInputField[] = [{
					id: output.indexOption,
					type: 'number',
					label: optionLabel(output.indexOption),
					default: defaultIndex,
					min: macroSelector ? 0 : row.min ?? defaultIndex,
					max: macroSelector ? self.getMacroMaximum() : row.max ?? 9999,
				}]
				feedbacks[feedbackId] = {
					name: `[${commandGroup(row.name)}] ${output.name}`,
					description: row.description,
					type: 'value',
					options,
					unsubscribe: (feedback) => self.releaseFeedbackValue(feedback.id),
					callback: (feedback: CompanionFeedbackValueEvent<FeedbackOptions>) => {
						const index = Math.trunc(Number(feedback.options[output.indexOption] ?? 0))
						self.watchFeedbackValue(feedback.id, row.oscPath, row.oscPath, output.source.startsWith('macro_') ? undefined : index)
						return specialFeedbackValue(self, output.source, index)
					},
				}
			}
			return
		}
		const valueSelectorPath = getValueSelectorPath(row)
		const parameterCount = valueSelectorPath ? 1 : getPathParameterCount(row.oscPath)
		const selectorPath = valueSelectorPath ?? row.oscPath
		const defaultAxis = getPathParameterDefault(selectorPath, 0)
		const selectorRow = valueSelectorPath ? { ...row, oscPath: valueSelectorPath } : row
		const selectorChoices = valueSelectorPath ? self.getParameterChoices(selectorRow, 0, defaultAxis) : undefined
		const options: SomeCompanionFeedbackInputField[] = Array.from({ length: parameterCount }, (_, index) => {
			const choices = valueSelectorPath && selectorChoices ? selectorChoices : self.getParameterChoices(selectorRow, index, defaultAxis).filter((choice) => choice.id !== 'all')
			const common = {
				id: `index_${index + 1}`,
				label: getPathAxisLabel(selectorPath, index),
				choices,
			}
			if (valueSelectorPath) {
				return { ...common, type: 'multidropdown' as const, default: [defaultAxis], sortSelection: true }
			}
			return { ...common, type: 'dropdown' as const, default: defaultAxis }
		})
		feedbacks[row.oscPath] = {
			name: row.name,
			description: row.description,
			type: 'value',
			options,
			unsubscribe: (feedback) => {
				self.releaseFeedbackValue(feedback.id)
			},
			callback: (feedback: CompanionFeedbackValueEvent<FeedbackOptions>) => {
				if (valueSelectorPath && selectorChoices) {
					self.watchFeedbackValue(feedback.id, row.oscPath)
					const current = self.getOscValue(row.oscPath)
					if (!Array.isArray(current)) return null
					const chosen = feedback.options.index_1
					const selected = Array.isArray(chosen) ? chosen : chosen === undefined || chosen === null ? [] : [chosen]
					const available = selectorChoices.flatMap((choice) => typeof choice.id === 'number' ? [choice.id] : [])
					const indexes = selected.includes('all')
						? available
						: [...new Set(selected.map(Number).filter((index) => Number.isInteger(index) && available.includes(index)))]
					return indexes.map((index) => {
						const value = current[index - 1]
						return getMappedValue(row, value, 'feedback') ?? value ?? null
					})
				}
				const indexes = Array.from({ length: parameterCount }, (_, index) => Number(feedback.options[`index_${index + 1}`] ?? defaultAxis))
				const path = materializePath(row.oscPath, indexes)
				self.watchFeedbackValue(feedback.id, path)
				const rawValue = self.getOscValue(path) ?? null
				const selectedMode = row.parameterKey === 'modes' && Array.isArray(rawValue)
					? rawValue[indexes[0]! - 1] ?? null
					: rawValue
				const value = row.parameterKey === 'Renumber_Snapshot' && typeof selectedMode === 'number'
					? selectedMode / 100
					: selectedMode
				logger.debug(`${feedback.id} read ${path} = ${JSON.stringify(value)}`)
				return getMappedValue(row, value, 'feedback') ?? value
			},
		}
	})
	self.setFeedbackDefinitions(feedbacks)
}
