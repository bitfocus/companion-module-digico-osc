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
	getPathParameterCount,
	getPathParameterDefault,
	isBooleanDataType,
	isReadable,
	isWritable,
	materializePath,
	oscDataType,
} from './commandTable.js'
import { getMappedChoices, getValueSelectorPath } from './valueMappings.js'

const logger = createModuleLogger('action')

export type ActionOptions = CompanionOptionValues
export type ActionsSchema = Record<string, { options: ActionOptions }>

function indexOption(index: number): string {
	return `index_${index + 1}`
}

function isExpressionOption(value: unknown): boolean {
	if (typeof value === 'string' && value.includes('$(')) return true
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		'isExpression' in value &&
		(value as { isExpression?: unknown }).isExpression === true
	)
}

function materializeActionPath(row: CommandRow, indexes: number[]): string {
	return materializePath(row.oscPath, indexes)
}

function axisDefault(row: CommandRow): number {
	return getPathParameterDefault(row.oscPath, 0)
}

function selectedIndexes(value: unknown, choices: Array<{ id: number | string }>, fallback: number): number[] {
	const validIndexes = choices.flatMap((choice) => (typeof choice.id === 'number' ? [choice.id] : []))
	const selected = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
	if (selected.includes('all')) return validIndexes.length > 0 ? validIndexes : [fallback]
	const indexes = selected.map(Number).filter((index) => Number.isInteger(index) && validIndexes.includes(index))
	return [...new Set(indexes.length > 0 ? indexes : [fallback])]
}

function indexCombinations(axes: number[][]): number[][] {
	return axes.reduce<number[][]>(
		(combinations, values) => combinations.flatMap((combination) => values.map((value) => [...combination, value])),
		[[]],
	)
}

function actionPaths(
	row: CommandRow,
	options: CompanionOptionValues,
	parameterCount: number,
	parameterChoices: Array<Array<{ id: number | string }>>,
	fallback: number,
): string[] {
	const selected = Array.from({ length: parameterCount }, (_, index) =>
		selectedIndexes(options[indexOption(index)], parameterChoices[index]!, fallback),
	)
	return indexCombinations(selected).map((indexes) => materializeActionPath(row, indexes))
}

function presetScopeSection(section: string): string {
	const normalized = section.trim().toLowerCase().replace(/\s+/g, '_')
	const scopeSections: Record<string, string> = {
		aux_mix: 'Aux Outputs',
		aux_outputs: 'Aux Outputs',
		input_channels: 'Input Channels',
		group_outputs: 'Group Outputs',
		talkback_outputs: 'Talkback Outputs',
		matrix_inputs: 'Matrix Inputs',
		matrix_outputs: 'Matrix Outputs',
		graphic_eq: 'Graphic EQ',
		control_groups: 'Control Groups',
		fx: 'FX',
		multis: 'Multis',
	}
	return scopeSections[normalized] ?? section.trim()
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function interpolateValue(row: CommandRow, from: number, to: number, progress: number): number {
	if (row.units.toLowerCase() !== 'db') return from + (to - from) * progress

	// DiGiCo's -150 dB value represents fader-off. Interpolate linear amplitude,
	// then convert back to dB so the gain ramp is smooth across the fader's range.
	const floorDb = -150
	const fromAmplitude = 10 ** (Math.max(floorDb, from) / 20)
	const toAmplitude = 10 ** (Math.max(floorDb, to) / 20)
	const amplitude = fromAmplitude + (toAmplitude - fromAmplitude) * progress
	return amplitude > 0 ? 20 * Math.log10(amplitude) : floorDb
}

function displayValue(row: CommandRow, value: number): number {
	if (row.parameterKey === 'Renumber_Snapshot') return value / 100
	return row.units.toLowerCase() === 'ms' ? value * 1000 : value
}

function oscValue(row: CommandRow, value: number): number {
	if (row.parameterKey === 'Renumber_Snapshot') return value * 100
	return row.units.toLowerCase() === 'ms' ? value / 1000 : value
}

function valueOptionLabel(row: CommandRow): string {
	const valueName = row.name
		.replace(/^\[[^\]]+\]\s*/, '')
		.split('/')
		.at(-1)
		?.trim()
	const words = (valueName || 'Value')
		.replace(/[_-]+/g, ' ')
		.replace(/\bgeq\b/gi, 'GEQ')
		.replace(/\beq\b/gi, 'EQ')
	const label = words.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
	return row.units ? `${label} (${row.units})` : label
}

export function UpdateActions(self: ModuleInstance, rows: CommandRow[]): void {
	const actions: CompanionActionDefinitions<ActionsSchema> = {}
	rows.forEach((row) => {
		if (!isWritable(row)) return
		if (row.oscPath === '/Presets/New_Preset') {
			const sections = self.getPresetSections()
			const options: SomeCompanionActionInputField[] = [
				{
					id: 'section',
					type: 'dropdown',
					label: 'Section',
					choices: sections.length > 0
						? sections.map((section) => ({ id: section, label: section }))
						: [{ id: '', label: 'No sections found' }],
					default: sections[0] ?? '',
					disableAutoExpression: true,
				},
			]
			const sectionOptionIds = new Map<string, { group: string; target: string }>()
			sections.forEach((section, sectionIndex) => {
				const groupOptionId = `group_${sectionIndex}`
				const targetOptionId = `target_${sectionIndex}`
				sectionOptionIds.set(section, { group: groupOptionId, target: targetOptionId })
				const visibleWhenSelected = `$(options:section) == ${JSON.stringify(section)}`
				const groups = self.getPresetGroupChoices(section)
				const targets = self.getPresetTargetChoices(section)
				options.push({
					id: groupOptionId,
					type: 'dropdown',
					label: 'Group',
					choices: groups.length > 0 ? groups : [{ id: JSON.stringify([section, '']), label: '(No Group)' }],
					default: groups[0]?.id ?? JSON.stringify([section, '']),
					isVisibleExpression: visibleWhenSelected,
				})
				options.push({
					id: targetOptionId,
					type: 'multidropdown',
					label: 'Value',
					choices: [
						{ id: 'all', label: 'All' },
						...(targets.length > 0 ? targets : [{ id: 1, label: 'No targets found' }]),
					],
					default: targets[0] ? [targets[0].id] : [],
					sortSelection: true,
					isVisibleExpression: visibleWhenSelected,
				})
			})
			options.push({ id: 'value', type: 'textinput', label: 'Name', default: '' })
			actions[row.oscPath] = {
				name: row.name,
				description: row.description,
				options,
				optionsToMonitorForSubscribe: options.map((option) => option.id),
				subscribe: () => undefined,
				callback: async (event: CompanionActionEvent<ActionOptions>) => {
					const section = String(event.options.section ?? sections[0] ?? '')
					const sectionOption = sectionOptionIds.get(section)
					if (!sectionOption) return
					const targets = self.getPresetTargetChoices(section)
					if (targets.length === 0) {
						logger.warn(`Cannot create a preset for section ${section}: no target choices are available`)
						return
					}
					let group = ''
					try {
						const parsed: unknown = JSON.parse(
							String(event.options[sectionOption.group] ?? JSON.stringify([section, ''])),
						)
						if (Array.isArray(parsed) && typeof parsed[1] === 'string') group = parsed[1]
					} catch {
						logger.warn(`Unable to read selected preset group: ${String(event.options.group)}`)
						return
					}
					const name = String(event.options.value ?? '').trim()
					const targetIndexes = selectedIndexes(
						event.options[sectionOption.target],
						[{ id: 'all' }, ...targets],
						targets[0]!.id,
					)
					const scopeSection = presetScopeSection(section)
					for (const index of targetIndexes) {
						const previousIndexes = self.getPresetIndexes()
						self.send_osc(row.oscPath, [
							{ type: 's', value: group },
							{ type: 's', value: `/${scopeSection}/${index}` },
						])
						await sleep(250)
						await self.refreshPresetData()
						let createdIndex = self.getNewPresetIndex(previousIndexes)
						if (createdIndex === undefined) {
							await sleep(250)
							await self.refreshPresetData()
							createdIndex = self.getNewPresetIndex(previousIndexes)
						}
						if (createdIndex === undefined) {
							logger.warn('New preset was sent but no new preset index appeared in the refreshed list')
							continue
						}
						if (name) {
							self.send_osc(`/Presets/Rename_Preset/${createdIndex}`, [{ type: 's', value: name }])
							await sleep(150)
							await self.refreshPresetData()
						}
					}
				},
			}
			return
		}
		if (row.oscPath === '/Presets/Rename_Preset_Group/*') {
			const groups = self.getPresetGroupRenameChoices()
			const options: SomeCompanionActionInputField[] = [
				{
					id: 'group',
					type: 'dropdown',
					label: 'Group',
					choices: groups.length > 0 ? groups : [{ id: 0, label: 'No groups found' }],
					default: groups[0]?.id ?? 0,
				},
				{ id: 'value', type: 'textinput', label: 'Name', default: '' },
			]
			actions[row.oscPath] = {
				name: row.name,
				description: row.description,
				options,
				optionsToMonitorForSubscribe: options.map((option) => option.id),
				subscribe: () => undefined,
				callback: async (event: CompanionActionEvent<ActionOptions>) => {
					const groupIndex = Number(event.options.group ?? groups[0]?.id)
					if (!groups.some((group) => group.id === groupIndex)) return
					const path = materializePath(row.oscPath, [groupIndex])
					self.send_osc(path, [{ type: 's', value: String(event.options.value ?? '') }])
					await self.refreshPresetData()
				},
			}
			return
		}
		if (row.oscPath === '/Presets/Update_Preset/*') {
			const sections = self.getPresetSections()
			const options: SomeCompanionActionInputField[] = [
				{
					id: 'preset_section',
					type: 'dropdown',
					label: 'Section',
					choices: sections.length > 0
						? sections.map((section) => ({ id: section, label: section }))
						: [{ id: '', label: 'No presets found' }],
					default: sections[0] ?? '',
					disableAutoExpression: true,
				},
			]
			const sectionOptionIds = new Map<string, { preset: string; value: string }>()
			sections.forEach((section, sectionIndex) => {
				const presetOptionId = `preset_${sectionIndex}`
				const valueOptionId = `value_${sectionIndex}`
				sectionOptionIds.set(section, { preset: presetOptionId, value: valueOptionId })
				const visibleWhenSelected = `$(options:preset_section) == ${JSON.stringify(section)}`
				const presetChoices = self.getPresetChoicesForSection(section)
				const targetChoices = self.getPresetTargetChoices(section)
				options.push({
					id: presetOptionId,
					type: 'dropdown',
					label: 'Preset',
					choices: presetChoices.length > 0 ? presetChoices : [{ id: 0, label: 'No presets in this section' }],
					default: presetChoices[0]?.id ?? 0,
					isVisibleExpression: visibleWhenSelected,
				})
				options.push({
					id: valueOptionId,
					type: 'dropdown',
					label: 'Value',
					choices: targetChoices.length > 0 ? targetChoices : [{ id: 1, label: 'No targets found' }],
					default: targetChoices[0]?.id ?? 1,
					isVisibleExpression: visibleWhenSelected,
				})
			})
			actions[row.oscPath] = {
				name: row.name,
				description: row.description,
				options,
				optionsToMonitorForSubscribe: options.map((option) => option.id),
				subscribe: () => undefined,
				callback: async (event: CompanionActionEvent<ActionOptions>) => {
					const section = String(event.options.preset_section ?? sections[0] ?? '')
					const selectedOptionIds = sectionOptionIds.get(section)
					if (!selectedOptionIds) return
					const presets = self.getPresetChoicesForSection(section)
					const rawPreset = Number(event.options[selectedOptionIds.preset] ?? presets[0]?.id ?? 0)
					const presetIndex = presets.some((choice) => choice.id === rawPreset) ? rawPreset : presets[0]?.id
					if (presetIndex === undefined) return
					const targets = self.getPresetTargetChoices(section)
					const rawTarget = Number(event.options[selectedOptionIds.value] ?? targets[0]?.id ?? 1)
					const targetIndex = targets.some((choice) => choice.id === rawTarget) ? rawTarget : targets[0]?.id
					if (targetIndex === undefined) return
					const path = materializePath(row.oscPath, [presetIndex])
					const scopeSection = presetScopeSection(section)
					self.send_osc(path, [{ type: 's', value: `/${scopeSection}/${targetIndex}` }])
				},
			}
			return
		}
		if (row.oscPath === '/Presets/Recall_Preset/*') {
			const sections = self.getPresetSections()
			const sectionChoices = sections.map((section) => ({ id: section, label: section }))
			const options: SomeCompanionActionInputField[] = [
				{
					id: 'preset_section',
					type: 'dropdown',
					label: 'Section',
					choices: sectionChoices.length > 0 ? sectionChoices : [{ id: '', label: 'No presets found' }],
					default: sections[0] ?? '',
					disableAutoExpression: true,
				},
			]
			const sectionOptionId = new Map<string, { preset: string; value: string }>()
			sections.forEach((section, sectionIndex) => {
				const presetOptionId = `preset_${sectionIndex}`
				const valueOptionId = `value_${sectionIndex}`
				sectionOptionId.set(section, { preset: presetOptionId, value: valueOptionId })
				const visibleWhenSelected = `$(options:preset_section) == ${JSON.stringify(section)}`
				const presetChoices = self.getPresetChoicesForSection(section)
				const targetChoices = self.getPresetTargetChoices(section)
				options.push({
					id: presetOptionId,
					type: 'dropdown',
					label: 'Preset',
					choices: presetChoices.length > 0 ? presetChoices : [{ id: 0, label: 'No presets in this section' }],
					default: presetChoices[0]?.id ?? 0,
					isVisibleExpression: visibleWhenSelected,
				})
				options.push({
					id: valueOptionId,
					type: 'multidropdown',
					label: 'Value',
					choices: [
						{ id: 'all', label: 'All' },
						...(targetChoices.length > 0 ? targetChoices : [{ id: 1, label: 'No targets found' }]),
					],
					default: targetChoices[0] ? [targetChoices[0].id] : [],
					sortSelection: true,
					isVisibleExpression: visibleWhenSelected,
				})
			})
			actions[row.oscPath] = {
				name: row.name,
				description: row.description,
				options,
				optionsToMonitorForSubscribe: options.map((option) => option.id),
				subscribe: () => undefined,
				callback: async (event: CompanionActionEvent<ActionOptions>) => {
					const section = String(event.options.preset_section ?? sections[0] ?? '')
					const selectedOptionIds = sectionOptionId.get(section) ?? sectionOptionId.get(sections[0] ?? '')
					if (!selectedOptionIds) return
					const presets = self.getPresetChoicesForSection(section)
					const rawPreset = Number(event.options[selectedOptionIds.preset] ?? presets[0]?.id ?? 0)
					const presetIndex = presets.some((choice) => choice.id === rawPreset) ? rawPreset : presets[0]?.id
					if (presetIndex === undefined) return
					const targets = self.getPresetTargetChoices(section)
					const targetIndexes = selectedIndexes(
						event.options[selectedOptionIds.value],
						[{ id: 'all' }, ...targets],
						targets[0]?.id ?? 1,
					)
					const path = materializePath(row.oscPath, [presetIndex])
					const sectionPath = section.trim()
					for (const index of targetIndexes) {
						self.send_osc(path, [{ type: 's', value: `/${sectionPath}/${index}` }])
					}
				},
			}
			return
		}
		const isRecallMacro = row.parameterKey === 'Recall_Macro'
		const isNewSnapshot = row.parameterKey === 'New_Snapshot'
		const isRecallSnapshot = row.parameterKey === 'Recall_Snapshot'
		const refreshSnapshotListAfterAction = [
			'New_Snapshot',
			'Insert_New_Snapshot',
			'Move_Snapshot',
			'Rename_Snapshot',
			'Delete_Snapshot',
			'Renumber_Snapshot',
			'Update_Snapshot',
			'Update_Current_Snapshot',
			'Update_Snapshot_Group',
		].includes(row.parameterKey)
		const refreshPresetListAfterAction = [
			'New_Preset',
			'Rename_Preset',
			'Rename_Preset_Group',
			'Delete_Preset',
			'Lock_Preset',
		].includes(row.parameterKey)
		const refreshMacroListAfterAction =
			/^\/Macros\/(New|Create|Delete|Rename|Move|Update|Save)_Macro(?:\/|$)/.test(row.oscPath)
		const isNoArgs = row.dataType === 'NoArgs'
		const valueSelectorPath = getValueSelectorPath(row)
		const parameterCount = valueSelectorPath ? 1 : getPathParameterCount(row.oscPath)
		const wireType = oscDataType(row.dataType)
		const isNumericValue = wireType === 'Int' || wireType === 'Float'
		const isBooleanValue = isBooleanDataType(row.dataType) || (row.dataType === 'Int' && row.min === 0 && row.max === 1)
		const mappedChoices = getMappedChoices(row)
		const hasNumericValue =
			isReadable(row) &&
			!isRecallMacro &&
			!isNewSnapshot &&
			!isRecallSnapshot &&
			!isNoArgs &&
			!isBooleanValue &&
			!valueSelectorPath &&
			!mappedChoices &&
			isNumericValue
		const defaultAxis = axisDefault(row)
		const singleSelector =
			row.oscPath.startsWith('/Snapshots/') ||
			row.oscPath === '/Macros/Recall_Macro/*' ||
			row.oscPath.startsWith('/Presets/')
		const selectorRow = valueSelectorPath ? { ...row, oscPath: valueSelectorPath } : row
		const parameterChoices = Array.from({ length: parameterCount }, (_, index) =>
			self.getParameterChoices(selectorRow, index, defaultAxis),
		)
		const options: SomeCompanionActionInputField[] = parameterChoices.map((choices, index) => {
			const common = {
				id: indexOption(index),
				label: getPathAxisLabel(selectorRow.oscPath, index),
				choices: singleSelector ? choices.filter((choice) => choice.id !== 'all') : choices,
			}
			if (singleSelector) return { ...common, type: 'dropdown' as const, default: defaultAxis }
			return { ...common, type: 'multidropdown' as const, default: [defaultAxis], sortSelection: true }
		})
		if (!isRecallMacro && !isNewSnapshot && !isRecallSnapshot && !isNoArgs) {
			if (valueSelectorPath) {
				const maximum = Math.max(2, Math.trunc(row.max ?? 2))
				const labels = new Map((mappedChoices ?? []).map(({ id, label }) => [id, label]))
				options.push({
					id: 'value',
					type: 'dropdown',
					label: 'Mode',
					default: row.min ?? 1,
					choices: Array.from({ length: maximum }, (_, index) => {
						const mode = index + 1
						return { id: mode, label: labels.get(mode) ?? String(mode) }
					}),
				})
			} else if (mappedChoices) {
				options.push({
					id: 'value',
					type: 'dropdown',
					label: 'Value',
					default: mappedChoices[0]?.id ?? 0,
					choices: mappedChoices,
				})
			} else if (row.dataType === 'String') {
				options.push({ id: 'value', type: 'textinput', label: 'Value', default: '' })
			} else {
				const scale = row.parameterKey === 'Renumber_Snapshot' ? 100 : 1
				const minimum = row.min === undefined ? -Number.MAX_SAFE_INTEGER : row.min / scale
				const maximum = row.max === undefined ? Number.MAX_SAFE_INTEGER : row.max / scale
				options.push({
					id: 'value',
					type: 'number',
					label: valueOptionLabel(row),
					default: Math.min(maximum, Math.max(minimum, 0)),
					min: minimum,
					max: maximum,
				})
				if (hasNumericValue) {
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
			}
		}

		const actionId = row.oscPath
		actions[actionId] = {
			name: row.name,
			description: row.description,
			options,
			optionsToMonitorForSubscribe: options.map((option) => option.id),
			subscribe: (action) => {
				if (isNoArgs || !isReadable(row)) return
				const paths = valueSelectorPath
					? [row.oscPath]
					: actionPaths(row, action.options, parameterCount, parameterChoices, defaultAxis)
				for (const path of paths) {
					// Reuse cached values; getOscValueOrQuery sends a query only on a cache miss.
					void self.getOscValueOrQuery(path)
				}
			},
			...(isReadable(row)
				? {
						learn: async (action: CompanionActionEvent<ActionOptions>) => {
							const expressionIndexes = Array.from({ length: parameterCount }, (_, index) =>
								isExpressionOption(action.options[indexOption(index)]),
							)
							const selected = Array.from({ length: parameterCount }, (_, index) =>
								selectedIndexes(action.options[indexOption(index)], parameterChoices[index]!, defaultAxis),
							)
							const indexes = selected.map((values) => values[0] ?? defaultAxis)
							const path = materializeActionPath(row, indexes)
							const result: Record<string, number | string> = {}
							const canLearnValue =
								!isRecallMacro &&
								!isNewSnapshot &&
								!isRecallSnapshot &&
								!isExpressionOption(action.options.value) &&
								!expressionIndexes.some(Boolean)
							if (canLearnValue) {
								const value = await self.getOscValueOrQuery(path)
								if (valueSelectorPath && Array.isArray(value)) {
									const selectedMode = value[(indexes[0] ?? defaultAxis) - 1]
									if (typeof selectedMode === 'number') result.value = selectedMode
								} else if (value !== undefined && value !== null) {
									result.value = row.dataType === 'String' ? String(value) : displayValue(row, Number(value))
								}
							}
							logger.debug(`Learn ${action.id} from ${path}: ${JSON.stringify(result)}`)
							return result
						},
					}
				: {}),
			callback: async (event: CompanionActionEvent<ActionOptions>) => {
				if (row.parameterKey === 'Change_Surface_Snapshot') {
					const paths = actionPaths(row, event.options, parameterCount, parameterChoices, defaultAxis)
					await Promise.all(paths.map((path) => self.runOscQuery(path)))
					return
				}
				if (valueSelectorPath) {
					const current = await self.getOscValueOrQuery(row.oscPath)
					if (!Array.isArray(current) || current.some((mode) => typeof mode !== 'number')) {
						logger.warn(`Cannot set ${row.oscPath}: mode array is unavailable`)
						return
					}
					const selected = selectedIndexes(event.options[indexOption(0)], parameterChoices[0]!, defaultAxis)
					const modes = current.map(Number)
					for (const index of selected) {
						if (index >= 1 && index <= modes.length) modes[index - 1] = Number(event.options.value ?? row.min ?? 1)
					}
					self.send_osc(
						row.oscPath,
						modes.map((mode) => ({ type: 'i' as const, value: mode })),
					)
					return
				}
				const paths = actionPaths(row, event.options, parameterCount, parameterChoices, defaultAxis)
				const value = event.options.value
				if (isBooleanValue && Number(value) === 2) {
					await Promise.all(
						paths.map(async (path) => {
							const current = await self.getOscValueOrQuery(path)
							if (typeof current !== 'number' || (current !== 0 && current !== 1)) {
								logger.warn(`Cannot toggle ${path}: current boolean value unavailable`)
								return
							}
							const toggledValue = current === 0 ? 1 : 0
							self.send_osc(
								path,
								wireType === 'Int' ? [{ type: 'i', value: toggledValue }] : [{ type: 'f', value: toggledValue }],
							)
						}),
					)
					return
				}

				if (hasNumericValue && (event.options.relative === true || event.options.crossfade === true)) {
					const toOscArgs = (number: number): OSCSomeArguments => {
						const value = oscValue(row, number)
						return wireType === 'Int' ? [{ type: 'i', value: Math.trunc(value) }] : [{ type: 'f', value }]
					}
					const enteredValue = Number(value ?? 0)
					const duration = Math.min(60000, Math.max(1, Number(event.options.crossfade_duration ?? 1000)))
					await Promise.all(
						paths.map(async (path) => {
							const currentValue = await self.getOscValueOrQuery(path)
							if (typeof currentValue !== 'number' || !Number.isFinite(currentValue)) {
								logger.warn(`Cannot apply relative or cross-fade value to ${path}: current numeric value unavailable`)
								return
							}
							const current = displayValue(row, currentValue)
							const target = event.options.relative === true ? current + enteredValue : enteredValue
							if (!event.options.crossfade) {
								self.send_osc(path, toOscArgs(target))
								return
							}

							const steps = Math.max(1, Math.ceil(duration / 50))
							const interval = duration / steps
							for (let step = 1; step <= steps; step++) {
								const interpolated = interpolateValue(row, current, target, step / steps)
								self.send_osc(path, toOscArgs(step === steps ? target : interpolated))
								if (step < steps) await sleep(interval)
							}
						}),
					)
					return
				}

				const args: OSCSomeArguments = isNoArgs
					? []
					: isRecallMacro || isNewSnapshot || isRecallSnapshot
						? [{ type: 'i', value: 0 }]
						: row.dataType === 'String'
							? [{ type: 's', value: String(value ?? '') }]
							: wireType === 'Int'
								? [{ type: 'i', value: Math.trunc(oscValue(row, Number(value ?? 0))) }]
								: [{ type: 'f', value: oscValue(row, Number(value ?? 0)) }]
				for (const path of paths) self.send_osc(path, args)
				if (refreshSnapshotListAfterAction) await self.refreshSnapshotData()
				if (refreshPresetListAfterAction) await self.refreshPresetData()
				if (refreshMacroListAfterAction) await self.refreshMacroData()
			},
		}
	})
	self.setActionDefinitions(actions)
}
