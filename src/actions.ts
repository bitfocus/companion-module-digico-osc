import type {
	CompanionActionDefinitions,
	CompanionActionEvent,
	CompanionOptionValues,
	OSCSomeArguments,
	SomeCompanionActionInputField,
} from '@companion-module/base'
import { createModuleLogger } from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { CommandRow } from './commandTable.js'
import {
	getPathAxisLabel,
	getPathAxisSegment,
	getPathEndpoint,
	getPathParameterCount,
	isBooleanDataType,
	isNoArgs,
	isReadable,
	isWritable,
	materializePath,
	oscDataType,
} from './commandTable.js'
import { getMappedChoices, getValueSelectorPath } from './valueMappings.js'
import { getEntityRecordDefinition, hasEntityRoot } from './entityRecords.js'

const logger = createModuleLogger('action')

export type ActionOptions = CompanionOptionValues
export type ActionsSchema = Record<string, { options: ActionOptions }>

function actionEndpoint(row: CommandRow): string {
	return getPathEndpoint(row.oscPath)
}

function optionIndexes(value: unknown, choices: Array<{ id: number | string }>, fallback = 1): number[] {
	const valid = choices.flatMap((choice) => (typeof choice.id === 'number' ? [choice.id] : []))
	const selected = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
	if (selected.includes('all')) return valid.length ? valid : [fallback]
	const indexes = [...new Set(selected.map(Number).filter((index) => Number.isInteger(index) && valid.includes(index)))]
	return indexes.length ? indexes : [fallback]
}

function combinations(axes: number[][]): number[][] {
	return axes.reduce<number[][]>(
		(result, values) => result.flatMap((combination) => values.map((value) => [...combination, value])),
		[[]],
	)
}

function selectedPaths(
	path: string,
	options: CompanionOptionValues,
	selectors: Array<Array<{ id: number | string }>>,
	fallback = 1,
): string[] {
	const indexes = selectors.map((choices, axis) => optionIndexes(options[`index_${axis + 1}`], choices, fallback))
	return combinations(indexes).map((values) => materializePath(path, values))
}

function valueLabel(row: CommandRow): string {
	const label = row.name.split('/').pop() || 'Value'
	return row.units ? `${label} (${row.units})` : label
}

function stringValue(value: unknown, fallback = ''): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
	return fallback
}

function numberFromWire(row: CommandRow, value: number): number {
	return value * row.scale
}

function numberToWire(row: CommandRow, value: number): number {
	return value / row.scale
}

function wireArguments(row: CommandRow, value: unknown): OSCSomeArguments {
	const type = oscDataType(row.dataType)
	if (!type) return []
	if (type === 'String') return [{ type: 's', value: stringValue(value) }]
	const number = numberToWire(row, Number(value ?? 0))
	return type === 'Int' ? [{ type: 'i', value: Math.trunc(number) }] : [{ type: 'f', value: number }]
}

function interpolate(row: CommandRow, from: number, to: number, progress: number): number {
	if (row.units.toLowerCase() !== 'db') return from + (to - from) * progress
	const floor = -150
	const fromAmplitude = 10 ** (Math.max(floor, from) / 20)
	const toAmplitude = 10 ** (Math.max(floor, to) / 20)
	const amplitude = fromAmplitude + (toAmplitude - fromAmplitude) * progress
	return amplitude > 0 ? 20 * Math.log10(amplitude) : floor
}

function actionOptions(
	self: ModuleInstance,
	row: CommandRow,
	path: string,
	selectorDefinitions: Array<{ path: string; axis: number }>,
	selectorChoices?: Array<Array<{ id: number | string; label: string }>>,
): SomeCompanionActionInputField[] {
	const options: SomeCompanionActionInputField[] = []
	selectorDefinitions.forEach(({ path: selectorPath, axis }) => {
		const choices = selectorChoices?.[axis] ?? self.getParameterChoices(selectorPath, axis)
		const root = row.oscPath.split('/').filter(Boolean)[0]
		if (root && hasEntityRoot(root)) {
			const entityChoices = self.getEntityChoices(root)
			options.push({
				id: `index_${axis + 1}`,
				type: 'dropdown',
				label: root.slice(0, -1),
				choices: entityChoices.length ? entityChoices : [{ id: 0, label: `No ${root.toLowerCase()} found` }],
				default: entityChoices[0]?.id ?? 0,
			})
			return
		}
		options.push({
			id: `index_${axis + 1}`,
			type: 'multidropdown',
			label: getPathAxisLabel(path, axis),
			choices,
			default: [1],
			sortSelection: true,
		})
	})
	if (isNoArgs(row)) return options
	const mappedChoices = getMappedChoices(row)
	if (mappedChoices) {
		const label = row.oscPath.endsWith('/Recall_Scope') ? 'Scope' : 'Value'
		options.push({ id: 'value', type: 'dropdown', label, choices: mappedChoices, default: mappedChoices[0]?.id ?? 0 })
		return options
	}
	if (row.valueSelectorLabel) {
		const root = row.oscPath.split('/').filter(Boolean)[0]
		const choices = root && hasEntityRoot(root) ? self.getEntityChoices(root) : []
		options.push({
			id: 'value',
			type: 'dropdown',
			label: row.valueSelectorLabel,
			choices: choices.length ? choices : [{ id: 0, label: 'No choices found' }],
			default: choices[0]?.id ?? 0,
		})
		return options
	}
	const type = oscDataType(row.dataType)
	if (type === 'String') {
		options.push({ id: 'value', type: 'textinput', label: 'Value', default: '' })
		return options
	}
	const min = row.min ?? -Number.MAX_SAFE_INTEGER
	const max = row.max ?? Number.MAX_SAFE_INTEGER
	options.push({
		id: 'value',
		type: 'number',
		label: valueLabel(row),
		default: Math.min(max, Math.max(min, 0)),
		min,
		max,
	})
	if ((type === 'Int' || type === 'Float') && !isBooleanDataType(row.dataType) && isReadable(row)) {
		options.push(
			{ id: 'relative', type: 'checkbox', label: 'Relative', default: false },
			{ id: 'crossfade', type: 'checkbox', label: 'Cross-fade', default: false, disableAutoExpression: true },
			{
				id: 'crossfade_duration',
				type: 'number',
				label: 'Cross-fade duration (ms)',
				default: 1000,
				min: 1,
				max: 60000,
				isVisibleExpression: '$(options:crossfade)',
			},
		)
	}
	return options
}

type PresetOptionSet = {
	options: SomeCompanionActionInputField[]
	sectionIds: Map<string, { item?: string; target?: string; group?: string }>
}

function presetActionOptions(self: ModuleInstance, row: CommandRow, rows: CommandRow[]): PresetOptionSet {
	const sections = self.getPresetSections()
	const options: SomeCompanionActionInputField[] = [
		{
			id: 'section',
			type: 'dropdown',
			label: 'Section',
			choices: sections.length
				? sections.map((section) => ({ id: section, label: section }))
				: [{ id: '', label: 'No presets found' }],
			default: sections[0] ?? '',
			disableAutoExpression: true,
		},
	]
	const sectionIds = new Map<string, { item?: string; target?: string; group?: string }>()
	const schema = actionEndpoint(row)
	for (const [sectionIndex, section] of sections.entries()) {
		const visible = `$(options:section) == ${JSON.stringify(section)}`
		const ids: { item?: string; target?: string; group?: string } = {}
		if (schema === 'Recall_Preset' || schema === 'Update_Preset') {
			const item = `preset_${sectionIndex}`
			ids.item = item
			const choices = self.getPresetChoicesForSection(section)
			options.push({
				id: item,
				type: 'dropdown',
				label: 'Preset',
				choices: choices.length ? choices : [{ id: 0, label: 'No presets in this section' }],
				default: choices[0]?.id ?? 0,
				isVisibleExpression: visible,
			})
		} else if (row.oscPath.includes('*')) {
			const item = `index_1_${sectionIndex}`
			ids.item = item
			const choices =
				schema === 'Rename_Preset_Group'
					? self.getPresetGroupRenameChoices(section)
					: self.getPresetChoicesForSection(section)
			options.push({
				id: item,
				type: 'dropdown',
				label: schema === 'Rename_Preset_Group' ? 'Group' : 'Preset',
				choices: choices.length ? choices : [{ id: 0, label: 'No items in this section' }],
				default: choices[0]?.id ?? 0,
				isVisibleExpression: visible,
			})
		}
		if (schema === 'Recall_Preset' || schema === 'Update_Preset' || schema === 'New_Preset') {
			const target = `target_${sectionIndex}`
			ids.target = target
			const choices = self.getPresetTargetChoices(section)
			const targetChoices =
				schema === 'Recall_Preset' || schema === 'New_Preset' ? [{ id: 'all', label: 'All' }, ...choices] : choices
			if (schema === 'Update_Preset') {
				options.push({
					id: target,
					type: 'dropdown',
					label: 'Value',
					choices: targetChoices,
					default: choices[0]?.id ?? 1,
					isVisibleExpression: visible,
				})
			} else {
				options.push({
					id: target,
					type: 'multidropdown',
					label: 'Value',
					choices: targetChoices,
					default: choices[0] ? [choices[0].id] : [],
					sortSelection: true,
					isVisibleExpression: visible,
				})
			}
		}
		if (schema === 'New_Preset') {
			const group = `group_${sectionIndex}`
			ids.group = group
			const choices = self.getPresetGroupChoices(section)
			options.push({
				id: group,
				type: 'dropdown',
				label: 'Group',
				choices: choices.length ? choices : [{ id: '', label: '(No Group)' }],
				default: choices[0]?.id ?? '',
				isVisibleExpression: visible,
			})
		}
		sectionIds.set(section, ids)
	}
	if (schema === 'Recall_Preset') {
		const scopeRow = rows.find((candidate) => candidate.oscPath === '/Presets/Recall_Scope')
		const choices = scopeRow ? getMappedChoices(scopeRow) : undefined
		if (choices?.length)
			options.push({ id: 'scope', type: 'dropdown', label: 'Scope', choices, default: choices[0].id })
	}
	if (schema === 'New_Preset') options.push({ id: 'value', type: 'textinput', label: 'Name', default: '' })
	else if (!['Recall_Preset', 'Update_Preset'].includes(schema)) {
		const valueOptions = actionOptions(self, row, row.oscPath, [])
		if (row.dataType === 'String') for (const option of valueOptions) if (option.id === 'value') option.label = 'Name'
		options.push(...valueOptions)
	}
	return { options, sectionIds }
}

export function UpdateActions(self: ModuleInstance, rows: CommandRow[]): void {
	const actions: CompanionActionDefinitions<ActionsSchema> = {}
	for (const row of rows) {
		if (!isWritable(row)) continue
		const root = row.oscPath.split('/').filter(Boolean)[0]
		const presetFields = root === 'Presets' ? presetActionOptions(self, row, rows) : undefined
		const valueSelectorPath = getValueSelectorPath(row, rows)
		const selectorDefinitions = valueSelectorPath
			? [{ path: valueSelectorPath, axis: 0 }]
			: Array.from({ length: getPathParameterCount(row.oscPath) }, (_, axis) => ({ path: row.oscPath, axis }))
		const selectorChoices = selectorDefinitions.map(({ path, axis }) =>
			root && hasEntityRoot(root) ? self.getEntityChoices(root) : self.getParameterChoices(path, axis),
		)
		const options =
			presetFields?.options ??
			actionOptions(self, row, valueSelectorPath ?? row.oscPath, selectorDefinitions, selectorChoices)
		const wireType = oscDataType(row.dataType)
		const booleanValue = isBooleanDataType(row.dataType) || (row.dataType === 'Int' && row.min === 0 && row.max === 1)
		const id = row.oscPath
		const action = {
			name: row.name,
			description: row.description,
			options,
			...(isReadable(row) && !isNoArgs(row) && actionEndpoint(row) !== 'Update_Preset'
				? {
						learn: async (event: CompanionActionEvent<ActionOptions>) => {
							let selectedIndex: number | undefined
							if (presetFields) {
								const section = stringValue(event.options.section, self.getPresetSections()[0] ?? '')
								const sectionOption = presetFields.sectionIds.get(section)
								if (!sectionOption) return {}
								selectedIndex = sectionOption.item
									? Number(event.options[sectionOption.item] ?? self.getPresetChoicesForSection(section)[0]?.id)
									: undefined
							} else if (getPathParameterCount(row.oscPath)) {
								selectedIndex = Number(event.options.index_1 ?? selectorChoices[0]?.[0]?.id)
							}
							if (row.learnSchema && selectedIndex !== undefined) {
								const entityRoot = row.oscPath.split('/').filter(Boolean)[0]
								const record = await self.getOscValueOrQuery(`/${entityRoot}/name`, undefined, selectedIndex)
								const field =
									record && typeof record === 'object' && !Array.isArray(record)
										? (record as Record<string, unknown>)[row.learnSchema]
										: undefined
								return typeof field === 'number'
									? { value: numberFromWire(row, field) }
									: typeof field === 'string'
										? { value: field }
										: {}
							}
							if (row.feedbackSchema === 'indexedRecord' && selectedIndex !== undefined) {
								const recordDefinition = getEntityRecordDefinition(row.oscPath)
								const record = recordDefinition?.queryPath
									? await self.getIndexedRecordOrQuery(
											recordDefinition.responsePath,
											selectedIndex,
											recordDefinition.queryPath,
										)
									: await self.getOscValueOrQuery(row.oscPath, undefined, selectedIndex)
								const valueKey = getPathAxisSegment(row.oscPath, getPathParameterCount(row.oscPath) - 1)
								const value =
									record && typeof record === 'object' && !Array.isArray(record) && valueKey
										? (record as Record<string, unknown>)[valueKey]
										: undefined
								return typeof value === 'number'
									? { value: numberFromWire(row, value) }
									: typeof value === 'string'
										? { value }
										: {}
							}
							const paths = selectedPaths(row.oscPath, event.options, selectorChoices)
							if (valueSelectorPath) {
								const value = await self.getOscValueOrQuery(row.oscPath)
								if (!Array.isArray(value)) return {}
								const indexes = optionIndexes(event.options.index_1, selectorChoices[0])
								const selected = value[indexes[0] - 1]
								return typeof selected === 'number' ? { value: numberFromWire(row, selected) } : {}
							}
							const value = await self.getOscValueOrQuery(paths[0])
							if (typeof value === 'number') return { value: numberFromWire(row, value) }
							if (typeof value === 'string') return { value }
							return {}
						},
					}
				: {}),
			callback: async (event: CompanionActionEvent<ActionOptions>) => {
				if (presetFields) {
					const section = stringValue(event.options.section, self.getPresetSections()[0] ?? '')
					const sectionOption = presetFields.sectionIds.get(section)
					if (!sectionOption) return
					if (actionEndpoint(row) === 'Recall_Preset') {
						const presets = self.getPresetChoicesForSection(section)
						const presetIndex = Number(event.options[sectionOption.item!] ?? presets[0]?.id)
						if (!presets.some((choice) => choice.id === presetIndex)) return
						const targets = self.getPresetTargetChoices(section)
						const targetIndexes = optionIndexes(
							event.options[sectionOption.target!],
							[{ id: 'all' }, ...targets],
							targets[0]?.id ?? 1,
						)
						self.send_osc('/Presets/Recall_Scope', [{ type: 'i', value: Math.trunc(Number(event.options.scope ?? 0)) }])
						for (const target of targetIndexes)
							self.send_osc(`/Presets/Recall_Preset/${presetIndex}`, [{ type: 's', value: `/${section}/${target}` }])
						return
					}
					if (actionEndpoint(row) === 'Update_Preset') {
						const presets = self.getPresetChoicesForSection(section)
						const presetIndex = Number(event.options[sectionOption.item!] ?? presets[0]?.id)
						const targets = self.getPresetTargetChoices(section)
						const target = Number(event.options[sectionOption.target!] ?? targets[0]?.id)
						if (presets.some((choice) => choice.id === presetIndex) && targets.some((choice) => choice.id === target)) {
							self.send_osc(`/Presets/Update_Preset/${presetIndex}`, [
								{ type: 's', value: `/${self.getPresetTargetSection(section)}/${target}` },
							])
						}
						return
					}
					if (actionEndpoint(row) === 'New_Preset') {
						const targets = self.getPresetTargetChoices(section)
						const targetIndexes = optionIndexes(
							event.options[sectionOption.target!],
							[{ id: 'all' }, ...targets],
							targets[0]?.id ?? 1,
						)
						const group = stringValue(event.options[sectionOption.group!])
						const name = stringValue(event.options.value).trim()
						for (const target of targetIndexes) {
							const previous = new Set(self.getEntityIndexes('Presets'))
							const refreshed = self.waitForEntityRefresh('Presets')
							self.send_osc(row.oscPath, [
								{ type: 's', value: group },
								{ type: 's', value: `/${self.getPresetTargetSection(section)}/${target}` },
							])
							if (!(await refreshed)) continue
							const created = self.getEntityIndexes('Presets').find((index) => !previous.has(index))
							if (created !== undefined && name) {
								self.send_osc(`/Presets/Rename_Preset/${created}`, [{ type: 's', value: name }])
							}
						}
						return
					}
					const indexes = row.oscPath.includes('*') ? [Number(event.options[sectionOption.item!] ?? 0)] : []
					const path = materializePath(row.oscPath, indexes)
					if (booleanValue && Number(event.options.value) === 2) {
						const current = await self.getOscValueOrQuery(path)
						if (typeof current !== 'number' || (current !== 0 && current !== 1)) return
						self.send_osc(path, wireArguments(row, current === 0 ? 1 : 0))
					} else {
						self.send_osc(path, wireArguments(row, event.options.value))
					}
					return
				}
				const paths = selectedPaths(row.oscPath, event.options, selectorChoices, root && hasEntityRoot(root) ? 0 : 1)
				if (valueSelectorPath) {
					const current = await self.getOscValueOrQuery(row.oscPath)
					if (!Array.isArray(current) || current.some((value) => typeof value !== 'number')) {
						logger.warn(`Cannot set ${row.oscPath}: current value array is unavailable`)
						return
					}
					const indexes = optionIndexes(event.options.index_1, selectorChoices[0])
					const updated = current.map(Number)
					for (const index of indexes)
						if (index > 0 && index <= updated.length) updated[index - 1] = Number(event.options.value ?? row.min ?? 0)
					self.send_osc(
						row.oscPath,
						updated.map((value) => ({ type: 'i' as const, value })),
					)
					return
				}
				const value = event.options.value
				if (booleanValue && Number(value) === 2) {
					await Promise.all(
						paths.map(async (path) => {
							const current = await self.getOscValueOrQuery(path)
							if (typeof current !== 'number' || (current !== 0 && current !== 1)) {
								logger.warn(`Cannot toggle ${path}: current boolean value is unavailable`)
								return
							}
							self.send_osc(path, wireArguments(row, current === 0 ? 1 : 0))
						}),
					)
					return
				}
				if (
					(event.options.relative === true || event.options.crossfade === true) &&
					wireType &&
					wireType !== 'String'
				) {
					const duration = Math.min(60000, Math.max(1, Number(event.options.crossfade_duration ?? 1000)))
					await Promise.all(
						paths.map(async (path) => {
							const raw = await self.getOscValueOrQuery(path)
							if (typeof raw !== 'number' || !Number.isFinite(raw)) {
								logger.warn(`Cannot ramp ${path}: current numeric value is unavailable`)
								return
							}
							const current = numberFromWire(row, raw)
							const entered = Number(value ?? 0)
							const target = event.options.relative === true ? current + entered : entered
							if (event.options.crossfade !== true) {
								self.send_osc(path, wireArguments(row, target))
								return
							}
							const steps = Math.max(1, Math.ceil(duration / 50))
							for (let step = 1; step <= steps; step++) {
								self.send_osc(
									path,
									wireArguments(row, step === steps ? target : interpolate(row, current, target, step / steps)),
								)
								if (step < steps) await new Promise<void>((resolve) => setTimeout(resolve, duration / steps))
							}
						}),
					)
					return
				}
				const args = wireArguments(row, value)
				for (const path of paths) self.send_osc(path, args)
			},
		}
		actions[id] = action
	}
	self.setActionDefinitions(actions)
}
