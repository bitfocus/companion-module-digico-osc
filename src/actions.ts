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
	isBooleanDataType,
	isNoArgs,
	isReadable,
	isWritable,
	materializePath,
	oscDataType,
} from './commandTable.js'
import { getMappedChoices, getValueSelectorPath } from './valueMappings.js'

const logger = createModuleLogger('action')

export type ActionOptions = CompanionOptionValues
export type ActionsSchema = Record<string, { options: ActionOptions }>

function optionIndexes(value: unknown, choices: Array<{ id: number | string }>, fallback = 1): number[] {
	const valid = choices.flatMap((choice) => typeof choice.id === 'number' ? [choice.id] : [])
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
): string[] {
	const indexes = selectors.map((choices, axis) => optionIndexes(options[`index_${axis + 1}`], choices))
	return combinations(indexes).map((values) => materializePath(path, values))
}

function valueLabel(row: CommandRow): string {
	const label = row.name.split('/').at(-1) || 'Value'
	return row.units ? `${label} (${row.units})` : label
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
	if (type === 'String') return [{ type: 's', value: String(value ?? '') }]
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
): SomeCompanionActionInputField[] {
	const options: SomeCompanionActionInputField[] = []
	selectorDefinitions.forEach(({ path: selectorPath, axis }) => {
		const choices = self.getParameterChoices(selectorPath, axis)
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
		options.push({ id: 'value', type: 'dropdown', label: 'Value', choices: mappedChoices, default: mappedChoices[0]?.id ?? 0 })
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

export function UpdateActions(self: ModuleInstance, rows: CommandRow[]): void {
	const actions: CompanionActionDefinitions<ActionsSchema> = {}
	for (const row of rows) {
		if (!isWritable(row)) continue
		const valueSelectorPath = getValueSelectorPath(row, rows)
		const selectorDefinitions = valueSelectorPath
			? [{ path: valueSelectorPath, axis: 0 }]
			: Array.from({ length: getPathParameterCount(row.oscPath) }, (_, axis) => ({ path: row.oscPath, axis }))
		const options = actionOptions(self, row, valueSelectorPath ?? row.oscPath, selectorDefinitions)
		const selectorChoices = selectorDefinitions.map(({ path, axis }) => self.getParameterChoices(path, axis))
		const wireType = oscDataType(row.dataType)
		const booleanValue = isBooleanDataType(row.dataType) || (row.dataType === 'Int' && row.min === 0 && row.max === 1)
		const id = row.oscPath
		const action = {
			name: row.name,
			description: row.description,
			options,
			...(isReadable(row) ? {
				learn: async (event: CompanionActionEvent<ActionOptions>) => {
					if (isNoArgs(row) || valueSelectorPath || event.options.value !== undefined) return {}
					const paths = selectedPaths(row.oscPath, event.options, selectorChoices)
					const value = await self.getOscValueOrQuery(paths[0]!)
					if (typeof value === 'number') return { value: numberFromWire(row, value) }
					if (typeof value === 'string') return { value }
					return {}
				},
			} : {}),
			callback: async (event: CompanionActionEvent<ActionOptions>) => {
				const paths = selectedPaths(row.oscPath, event.options, selectorChoices)
				if (valueSelectorPath) {
					const current = await self.getOscValueOrQuery(row.oscPath)
					if (!Array.isArray(current) || current.some((value) => typeof value !== 'number')) {
						logger.warn(`Cannot set ${row.oscPath}: current value array is unavailable`)
						return
					}
					const indexes = optionIndexes(event.options.index_1, selectorChoices[0]!)
					const updated = current.map(Number)
					for (const index of indexes) if (index > 0 && index <= updated.length) updated[index - 1] = Number(event.options.value ?? row.min ?? 0)
					self.send_osc(row.oscPath, updated.map((value) => ({ type: 'i' as const, value })))
					return
				}
				const value = event.options.value
				if (booleanValue && Number(value) === 2) {
					await Promise.all(paths.map(async (path) => {
						const current = await self.getOscValueOrQuery(path)
						if (typeof current !== 'number' || (current !== 0 && current !== 1)) {
							logger.warn(`Cannot toggle ${path}: current boolean value is unavailable`)
							return
						}
						self.send_osc(path, wireArguments(row, current === 0 ? 1 : 0))
					}))
					return
				}
				if ((event.options.relative === true || event.options.crossfade === true) && wireType && wireType !== 'String') {
					const duration = Math.min(60000, Math.max(1, Number(event.options.crossfade_duration ?? 1000)))
					await Promise.all(paths.map(async (path) => {
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
							self.send_osc(path, wireArguments(row, step === steps ? target : interpolate(row, current, target, step / steps)))
							if (step < steps) await new Promise<void>((resolve) => setTimeout(resolve, duration / steps))
						}
					}))
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
