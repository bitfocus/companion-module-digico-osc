import type {
	CompanionFeedbackDefinitions,
	CompanionFeedbackBooleanEvent,
	CompanionFeedbackValueEvent,
	CompanionOptionValues,
	JsonValue,
	SomeCompanionFeedbackInputField,
} from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { CommandRow } from './commandTable.js'
import {
	getPathAxisLabel,
	getPathAxisSegment,
	getPathParameterCount,
	isBooleanDataType,
	isNoArgs,
	isReadable,
	materializePath,
} from './commandTable.js'
import { getMappedValue, getValueSelectorPath } from './valueMappings.js'
import { getEntityRecordDefinition, hasEntityRoot } from './entityRecords.js'

export type FeedbackOptions = CompanionOptionValues
export type FeedbacksSchema = Record<
	string,
	{ type: 'value'; options: FeedbackOptions; result: JsonValue } | { type: 'boolean'; options: FeedbackOptions }
>

function scaledFeedback(row: CommandRow, value: JsonValue): JsonValue {
	if (row.feedbackValueAsBoolean) {
		return typeof value === 'boolean' ? value : typeof value === 'number' && value === row.booleanFeedbackOnValue
	}
	const mapped = getMappedValue(row, value, 'feedback')
	if (mapped !== undefined) return mapped
	return typeof value === 'number' ? value * row.scale : value
}

export function UpdateFeedbacks(self: ModuleInstance, rows: CommandRow[]): void {
	const feedbacks: CompanionFeedbackDefinitions<FeedbacksSchema> = {}
	for (const row of rows) {
		if (!isReadable(row) || isNoArgs(row)) continue
		const entityRoot = row.oscPath.split('/').filter(Boolean)[0]
		if (row.feedbackSchema === 'snapshotNote') {
			const choices = self.getEntityChoices('Snapshots')
			feedbacks[row.oscPath] = {
				name: row.feedbackName || row.name,
				description: row.description,
				type: 'value',
				options: [
					{
						id: 'index',
						type: 'dropdown',
						label: 'Snapshot',
						choices: choices.length ? choices : [{ id: 0, label: 'No snapshots found' }],
						default: choices[0]?.id ?? 0,
					},
				],
				unsubscribe: (feedback) => self.releaseFeedbackValue(feedback.id),
				callback: async (feedback: CompanionFeedbackValueEvent<FeedbackOptions>) => {
					const index = Math.trunc(Number(feedback.options.index ?? 0))
					self.watchFeedbackValue(feedback.id, row.oscPath)
					const value = await self.getOscValueOrQuery(row.oscPath, undefined, index)
					return value && typeof value === 'object' && !Array.isArray(value)
						? ((value as { note?: JsonValue }).note ?? null)
						: null
				},
			}
			continue
		}
		if (row.feedbackSchema === 'entityRecord' && entityRoot) {
			const choices = self.getEntityChoices(entityRoot)
			feedbacks[row.oscPath] = {
				name: row.feedbackName || row.name,
				description: row.description,
				type: 'value',
				options: [
					{
						id: 'index',
						type: 'dropdown',
						label: entityRoot.slice(0, -1),
						choices: choices.length ? choices : [{ id: 0, label: `No ${entityRoot.toLowerCase()} found` }],
						default: choices[0]?.id ?? 0,
					},
				],
				unsubscribe: (feedback) => self.releaseFeedbackValue(feedback.id),
				callback: async (feedback: CompanionFeedbackValueEvent<FeedbackOptions>) => {
					const index = Math.trunc(Number(feedback.options.index ?? 0))
					self.watchFeedbackValue(feedback.id, row.oscPath)
					return (await self.getOscValueOrQuery(`/${entityRoot}/name`, undefined, index)) ?? null
				},
			}
			continue
		}
		const recordDefinition = getEntityRecordDefinition(row.oscPath)
		if (row.feedbackSchema === 'indexedRecord' && recordDefinition?.queryPath) {
			const choices = self.getIndexedRecordChoices(recordDefinition.responsePath)
			const recordSelectorOption: SomeCompanionFeedbackInputField = {
				id: 'index_1',
				type: 'dropdown',
				label: row.feedbackSelectorLabel || getPathAxisLabel(row.oscPath, 0),
				choices: choices.length
					? choices
					: [{ id: 0, label: recordDefinition.emptyChoicesLabel || `No ${entityRoot.toLowerCase()} found` }],
				default: choices[0]?.id ?? 0,
			}
			feedbacks[row.oscPath] = {
				name: row.name,
				description: row.description,
				type: 'value',
				options: [recordSelectorOption],
				unsubscribe: (feedback) => self.releaseFeedbackValue(feedback.id),
				callback: async (feedback: CompanionFeedbackValueEvent<FeedbackOptions>) => {
					const rawIndex = feedback.options.index_1
					const index = Math.trunc(Number(rawIndex ?? choices[0]?.id ?? 0))
					self.watchFeedbackValue(feedback.id, recordDefinition.responsePath)
					const record = await self.getIndexedRecordOrQuery(
						recordDefinition.responsePath,
						index,
						recordDefinition.queryPath!,
					)
					const valueKey = getPathAxisSegment(row.oscPath, 0)
					const value = valueKey ? record?.[valueKey] : undefined
					return scaledFeedback(row, value ?? null)
				},
			}
			if (
				row.booleanFeedbackId &&
				row.booleanFeedbackName &&
				row.booleanFeedbackStateField &&
				row.booleanFeedbackOnValue !== undefined &&
				row.booleanFeedbackOffValue !== undefined
			) {
				feedbacks[row.booleanFeedbackId] = {
					name: row.booleanFeedbackName,
					description: row.booleanFeedbackDescription || `True when ${row.name} matches the selected state.`,
					type: 'boolean',
					defaultStyle: { color: 0xffffff, bgcolor: 0x00aa00 },
					showInvert: false,
					options: [
						recordSelectorOption,
						{
							id: 'state',
							type: 'dropdown',
							label: row.booleanFeedbackStateLabel || 'State',
							choices: [
								{ id: row.booleanFeedbackOnValue, label: 'On' },
								{ id: row.booleanFeedbackOffValue, label: 'Off' },
							],
							default: row.booleanFeedbackOnValue,
						},
					],
					unsubscribe: (feedback) => self.releaseFeedbackValue(feedback.id),
					callback: async (feedback: CompanionFeedbackBooleanEvent<FeedbackOptions>) => {
						const index = Math.trunc(Number(feedback.options.index_1 ?? choices[0]?.id ?? 0))
						self.watchFeedbackValue(feedback.id, recordDefinition.responsePath)
						const record = await self.getIndexedRecordOrQuery(
							recordDefinition.responsePath,
							index,
							recordDefinition.queryPath!,
						)
						return (
							record !== undefined &&
							Number(record[row.booleanFeedbackStateField]) ===
								Number(feedback.options.state ?? row.booleanFeedbackOnValue)
						)
					},
				}
			}
			continue
		}
		if (row.feedbackSchema === 'recordArray' && recordDefinition?.arrayResult) {
			const selectors = recordDefinition.recordArraySelectors
			const positions = self.getEntityRecordPositions(row.oscPath)
			const bankSelector = selectors?.bank
			feedbacks[row.oscPath] = {
				name: row.feedbackName || row.name,
				description: row.description,
				type: 'value',
				options: [
					{
						id: selectors?.position.id ?? 'position',
						type: 'dropdown',
						label: selectors?.position.label ?? 'Position',
						choices: positions.length
							? positions.map(({ id, label }) => ({ id, label }))
							: [{ id: '', label: recordDefinition.emptyChoicesLabel || 'No positions found' }],
						default: positions[0]?.id ?? '',
						disableAutoExpression: true,
					},
					...positions.map((position): SomeCompanionFeedbackInputField => {
						const choices = self.getEntityRecordArrayChoices(row.oscPath, position.key)
						const optionId = `${bankSelector?.idPrefix ?? 'bank'}_${encodeURIComponent(position.key)}`
						return {
							id: optionId,
							type: 'dropdown',
							label: `${bankSelector?.label ?? 'Bank'} (${position.label})`,
							choices: choices.length
								? choices
								: [{ id: '', label: recordDefinition.emptyChoicesLabel || 'No banks in this position' }],
							default: choices[0]?.id ?? '',
							isVisibleExpression: `$(options:${selectors?.position.id ?? 'position'}) == ${JSON.stringify(position.id)}`,
							disableAutoExpression: true,
						}
					}),
				],
				unsubscribe: (feedback) => self.releaseFeedbackValue(feedback.id),
				callback: async (feedback: CompanionFeedbackValueEvent<FeedbackOptions>) => {
					self.watchFeedbackValue(feedback.id, row.oscPath)
					await self.getOscValueOrQuery(row.oscPath)
					const selectedPosition = feedback.options[selectors?.position.id ?? 'position']
					if (typeof selectedPosition !== 'string') return null
					const position = positions.find((candidate) => candidate.id === selectedPosition)
					if (!position) return null
					const optionId = `${bankSelector?.idPrefix ?? 'bank'}_${encodeURIComponent(position.key)}`
					const key = feedback.options[optionId]
					return typeof key === 'string' ? self.getEntityRecordArrayValue(row.oscPath, key) : null
				},
			}
			continue
		}
		const valueSelectorPath = getValueSelectorPath(row, rows)
		const selectorCount = valueSelectorPath ? 1 : getPathParameterCount(row.oscPath)
		const selectorPath = valueSelectorPath ?? row.oscPath
		const selectorEntityRoot = selectorPath.split('/').filter(Boolean)[0]
		const hasEntitySelector = !!selectorEntityRoot && hasEntityRoot(selectorEntityRoot)
		const selectorChoices = Array.from({ length: selectorCount }, (_, axis) =>
			hasEntitySelector
				? self.getEntityChoices(selectorEntityRoot)
				: self.getParameterChoices(selectorPath, valueSelectorPath ? 0 : axis),
		)
		const entitySections = hasEntitySelector ? self.getEntitySections(selectorEntityRoot) : []
		const sectionedSelector = selectorCount === 1 && entitySections.length > 0
		const options: SomeCompanionFeedbackInputField[] = sectionedSelector
			? [
					{
						id: 'section',
						type: 'dropdown',
						label: 'Section',
						choices: entitySections.map((section) => ({ id: section, label: section })),
						default: entitySections[0],
						disableAutoExpression: true,
					},
				]
			: selectorChoices.map((choices, axis) => {
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
					if (hasEntitySelector) {
						return {
							id: `index_${axis + 1}`,
							type: 'dropdown',
							label: selectorEntityRoot.slice(0, -1),
							choices: choices.length ? choices : [{ id: 0, label: `No ${selectorEntityRoot.toLowerCase()} found` }],
							default: choices[0]?.id ?? 0,
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
		if (sectionedSelector) {
			entitySections.forEach((section) => {
				const sectionKey = encodeURIComponent(section)
				const choices = self.getEntityChoices(selectorEntityRoot, section)
				options.push({
					id: `index_1_${sectionKey}`,
					type: 'dropdown',
					label: getPathAxisLabel(selectorPath, 0),
					choices: choices.length ? choices : [{ id: 0, label: 'No items in this section' }],
					default: choices[0]?.id ?? 0,
					isVisibleExpression: `$(options:section) == ${JSON.stringify(section)}`,
				})
			})
		}
		feedbacks[row.oscPath] = {
			name: row.feedbackName || row.name,
			description: row.description,
			type: 'value',
			options,
			unsubscribe: (feedback) => self.releaseFeedbackValue(feedback.id),
			callback: async (feedback: CompanionFeedbackValueEvent<FeedbackOptions>) => {
				if (valueSelectorPath) {
					self.watchFeedbackValue(feedback.id, row.oscPath)
					const values = await self.getOscValueOrQuery(row.oscPath)
					if (!Array.isArray(values)) return null
					const choices = selectorChoices[0]
					const selected = feedback.options.index_1
					const indexes = Array.isArray(selected)
						? selected
						: selected === undefined || selected === null
							? []
							: [selected]
					const available = choices.flatMap((choice) => (typeof choice.id === 'number' ? [choice.id] : []))
					const selectedIndexes = indexes.includes('all')
						? available
						: [...new Set(indexes.map(Number).filter((index) => Number.isInteger(index) && available.includes(index)))]
					return selectedIndexes.map((index) => scaledFeedback(row, values[index - 1] ?? null))
				}
				const selectedSection = feedback.options.section
				const section = typeof selectedSection === 'string' ? selectedSection : entitySections[0]
				const indexes = Array.from({ length: selectorCount }, (_, axis) =>
					Number(
						sectionedSelector
							? (feedback.options[`index_${axis + 1}_${encodeURIComponent(section ?? '')}`] ?? 0)
							: (feedback.options[`index_${axis + 1}`] ?? 1),
					),
				)
				const path = materializePath(row.oscPath, indexes)
				self.watchFeedbackValue(feedback.id, path)
				const value = (await self.getOscValueOrQuery(path)) ?? null
				return scaledFeedback(row, value)
			},
		}
		if (isBooleanDataType(row.dataType) || (row.dataType === 'Int' && row.min === 0 && row.max === 1)) {
			feedbacks[`${row.oscPath}#on`] = {
				name: `${row.name} (On)`,
				description: `True when ${row.name} is on.`,
				type: 'boolean',
				defaultStyle: { color: 0xffffff, bgcolor: 0xcc0000 },
				options,
				unsubscribe: (feedback) => self.releaseFeedbackValue(feedback.id),
				callback: async (feedback: CompanionFeedbackBooleanEvent<FeedbackOptions>) => {
					const selectedSection = feedback.options.section
					const section = typeof selectedSection === 'string' ? selectedSection : entitySections[0]
					const indexes = Array.from({ length: selectorCount }, (_, axis) =>
						Number(
							sectionedSelector
								? (feedback.options[`index_${axis + 1}_${encodeURIComponent(section ?? '')}`] ?? 0)
								: (feedback.options[`index_${axis + 1}`] ?? 1),
						),
					)
					const path = materializePath(row.oscPath, indexes)
					self.watchFeedbackValue(feedback.id, path)
					const value = await self.getOscValueOrQuery(path)
					return value === true || Number(value) === 1
				},
			}
		}
	}
	self.setFeedbackDefinitions(feedbacks)
}
