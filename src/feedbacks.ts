import type {
	CompanionFeedbackDefinitions,
	CompanionFeedbackValueEvent,
	CompanionOptionValues,
	JsonValue,
	SomeCompanionFeedbackInputField,
} from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { CommandRow } from './commandTable.js'
import { getPathAxisLabel, getPathParameterCount, isNoArgs, isReadable, materializePath } from './commandTable.js'
import { getMappedValue, getValueSelectorPath } from './valueMappings.js'

export type FeedbackOptions = CompanionOptionValues
export type FeedbacksSchema = Record<string, { type: 'value'; options: FeedbackOptions }>

function scaledFeedback(row: CommandRow, value: JsonValue): JsonValue {
	const mapped = getMappedValue(row, value, 'feedback')
	if (mapped !== undefined) return mapped
	return typeof value === 'number' ? value * row.scale : value
}

export function UpdateFeedbacks(self: ModuleInstance, rows: CommandRow[]): void {
	const feedbacks: CompanionFeedbackDefinitions<FeedbacksSchema> = {}
	for (const row of rows) {
		if (!isReadable(row) || isNoArgs(row)) continue
		const valueSelectorPath = getValueSelectorPath(row, rows)
		const selectorCount = valueSelectorPath ? 1 : getPathParameterCount(row.oscPath)
		const selectorPath = valueSelectorPath ?? row.oscPath
		const selectorChoices = Array.from({ length: selectorCount }, (_, axis) =>
			self.getParameterChoices(selectorPath, valueSelectorPath ? 0 : axis),
		)
		const options: SomeCompanionFeedbackInputField[] = selectorChoices.map((choices, axis) => {
			const label = getPathAxisLabel(selectorPath, valueSelectorPath ? 0 : axis)
			if (valueSelectorPath) {
				return {
					id: `index_${axis + 1}`,
					type: 'multidropdown',
					label,
					choices,
					default: [1],
					sortSelection: true,
				}
			}
			return {
				id: `index_${axis + 1}`,
				type: 'dropdown',
				label,
				choices: choices.filter((choice) => choice.id !== 'all'),
				default: 1,
			}
		})
		feedbacks[row.oscPath] = {
			name: row.name,
			description: row.description,
			type: 'value',
			options,
			unsubscribe: (feedback) => self.releaseFeedbackValue(feedback.id),
			callback: (feedback: CompanionFeedbackValueEvent<FeedbackOptions>) => {
				if (valueSelectorPath) {
					self.watchFeedbackValue(feedback.id, row.oscPath)
					const values = self.getOscValue(row.oscPath)
					if (!Array.isArray(values)) return null
					const choices = selectorChoices[0]!
					const selected = feedback.options.index_1
					const indexes = Array.isArray(selected) ? selected : selected === undefined || selected === null ? [] : [selected]
					const available = choices.flatMap((choice) => typeof choice.id === 'number' ? [choice.id] : [])
					const selectedIndexes = indexes.includes('all')
						? available
						: [...new Set(indexes.map(Number).filter((index) => Number.isInteger(index) && available.includes(index)))]
					return selectedIndexes.map((index) => scaledFeedback(row, values[index - 1] ?? null))
				}
				const indexes = Array.from({ length: selectorCount }, (_, axis) =>
					Number(feedback.options[`index_${axis + 1}`] ?? 1),
				)
				const path = materializePath(row.oscPath, indexes)
				self.watchFeedbackValue(feedback.id, path)
				const value = self.getOscValue(path) ?? null
				return scaledFeedback(row, value)
			},
		}
	}
	self.setFeedbackDefinitions(feedbacks)
}
