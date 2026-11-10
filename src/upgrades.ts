import type {
	CompanionMigrationAction,
	CompanionMigrationFeedback,
	CompanionStaticUpgradeProps,
	CompanionStaticUpgradeResult,
	CompanionStaticUpgradeScript,
	CompanionUpgradeContext,
	JsonValue,
} from '@companion-module/base'
import { createModuleLogger } from '@companion-module/base'
import type { ModuleConfig } from './config.js'
import { DEFAULT_CONFIG } from './config.js'
import { loadCommandTable, type CommandRow } from './commandTable.js'

type LegacyActionMapping = {
	actionId: string
	options: Record<string, string>
	convertNumericStrings?: string[]
}

const logger = createModuleLogger('upgrade')

const legacyActions: Record<string, LegacyActionMapping> = {
	snapshotNext: { actionId: '/Snapshots/Fire_Next_Snapshot', options: {} },
	snapshotPrev: { actionId: '/Snapshots/Fire_Prev_Snapshot', options: {} },
	snapshotNextS: { actionId: '/Snapshots/Fire_Next_Snapshot', options: {} },
	snapshotPrevS: { actionId: '/Snapshots/Fire_Prev_Snapshot', options: {} },
	snapshot: { actionId: '/Snapshots/Recall_Snapshot/*', options: { snapshot: 'index_1' } },
	snapshotS: { actionId: '/Snapshots/Recall_Snapshot/*', options: { snapshot: 'index_1' } },
	macros: { actionId: '/Macros/Recall_Macro/*', options: { macro: 'index_1' } },
	auxmute: {
		actionId: '/Aux_Outputs/*/mute',
		options: { channel: 'index_1', auxmute: 'value' },
		convertNumericStrings: ['auxmute'],
	},
	mute: {
		actionId: '/Input_Channels/*/mute',
		options: { channel: 'index_1', mute: 'value' },
		convertNumericStrings: ['mute'],
	},
	cgmute: {
		actionId: '/Control_Groups/*/mute',
		options: { channel: 'index_1', cgmute: 'value' },
		convertNumericStrings: ['cgmute'],
	},
	gomute: {
		actionId: '/Group_Outputs/*/mute',
		options: { channel: 'index_1', gomute: 'value' },
		convertNumericStrings: ['gomute'],
	},
	phantom: {
		actionId: '/Input_Channels/*/Channel_Input/phantom',
		options: { channel: 'index_1', phantom: 'value' },
		convertNumericStrings: ['phantom'],
	},
	fader: {
		actionId: '/Input_Channels/*/fader',
		options: { channel: 'index_1', fader: 'value' },
		convertNumericStrings: ['fader'],
	},
	solo: {
		actionId: '/Input_Channels/*/solo',
		options: { channel: 'index_1', solo: 'value' },
		convertNumericStrings: ['solo'],
	},
}

function isWrappedValue(value: unknown): value is { value: JsonValue | undefined; isExpression: boolean } {
	return typeof value === 'object' && value !== null && 'value' in value && 'isExpression' in value
}

function migrateAction(
	action: CompanionMigrationAction,
	series: string | undefined,
): CompanionMigrationAction | undefined {
	const mapping = legacyActions[action.actionId]
	if (!mapping) return undefined

	const options: CompanionMigrationAction['options'] = {}
	for (const [oldKey, newKey] of Object.entries(mapping.options)) {
		const oldValue = action.options[oldKey]
		if (oldValue === undefined) continue
		if (oldKey === 'channel' && newKey === 'index_1') {
			if (isWrappedValue(oldValue) && oldValue.isExpression) {
				options[newKey] = oldValue
				continue
			}
			const rawIndex = isWrappedValue(oldValue) ? oldValue.value : oldValue
			const index = Number(rawIndex)
			if (Number.isInteger(index)) {
				options[newKey] = isWrappedValue(oldValue)
					? { ...oldValue, value: [index] }
					: { isExpression: false, value: [index] }
				continue
			}
		}

		if (
			mapping.convertNumericStrings?.includes(oldKey) &&
			isWrappedValue(oldValue) &&
			!oldValue.isExpression &&
			typeof oldValue.value === 'string' &&
			oldValue.value.trim() !== '' &&
			Number.isFinite(Number(oldValue.value))
		) {
			options[newKey] = { ...oldValue, value: Number(oldValue.value) }
		} else {
			options[newKey] = oldValue
		}
	}

	if (action.actionId === 'fader' && series === 'OSC') {
		const oldValue = options.value
		if (isWrappedValue(oldValue) && !oldValue.isExpression) {
			const normalized = Number(oldValue.value)
			const faderChoices: Array<[number, number]> = [
				[0, -150],
				[0.125, -50],
			]
			for (let db = -30; db <= -12; db += 2) faderChoices.push([0.475 + ((db + 12) / 2) * 0.025, db])
			for (let db = -10; db <= 10; db++) faderChoices.push([(75 + db * 2.5) / 100, db])
			const match = faderChoices.find(([old]) => Math.abs(old - normalized) < 0.0001)
			if (match) options.value = { ...oldValue, value: match[1] }
			else {
				logger.warn(
					`[DiGiCo upgrade] Could not safely convert OSC fader value ${JSON.stringify(oldValue.value)}; leaving action unmigrated`,
				)
				return undefined
			}
		}
	}

	if (action.actionId === 'macros') {
		const old = action.options.macro
		if (isWrappedValue(old) && old.isExpression)
			return {
				...action,
				actionId: '/Macros/Buttons/press',
				options: { value: { isExpression: true, value: `(${String(old.value)}) - 1` } },
			}
		const index = Number(isWrappedValue(old) ? old.value : old) - 1
		return {
			...action,
			actionId: '/Macros/Buttons/press',
			options: { value: { isExpression: false, value: Number.isInteger(index) ? index : 0 } },
		}
	}

	return { ...action, actionId: mapping.actionId, options }
}

function migrateFeedback(
	feedback: CompanionMigrationFeedback,
	rows: CommandRow[],
): CompanionMigrationFeedback | undefined {
	const target = rows.find((row) => row.legacyFeedbackIds.includes(feedback.feedbackId))
	if (!target?.booleanFeedbackId) return undefined

	const macro = feedback.options.macro
	const state = feedback.options.state
	const fg = feedback.options.fg
	const bg = feedback.options.bg
	const macroValue = isWrappedValue(macro) ? macro.value : macro
	const stateValue = isWrappedValue(state) ? state.value : state
	const stateOption = isWrappedValue(state)
		? state
		: { isExpression: false as const, value: stateValue === null || stateValue === undefined ? 1 : stateValue }
	const macroIndex = Number(macroValue) - 1
	const style: CompanionMigrationFeedback['style'] = {}
	if (isWrappedValue(fg) && (typeof fg.value === 'string' || typeof fg.value === 'number')) style.color = fg.value
	if (isWrappedValue(bg) && (typeof bg.value === 'string' || typeof bg.value === 'number')) style.bgcolor = bg.value
	return {
		...feedback,
		feedbackId: target.booleanFeedbackId,
		options: {
			index_1: { isExpression: false, value: Number.isFinite(macroIndex) ? macroIndex : 0 },
			state: stateOption,
		},
		style,
	}
}

function upgradeLegacyDiGiCoControls(
	_context: CompanionUpgradeContext<ModuleConfig>,
	props: CompanionStaticUpgradeProps<ModuleConfig, undefined>,
): CompanionStaticUpgradeResult<ModuleConfig, undefined> {
	const series = (props.config as unknown as { series?: string } | null)?.series
	const updatedActions = props.actions.flatMap((action) => {
		const updated = migrateAction(action, series)
		if (updated) {
			logger.debug(
				`[DiGiCo upgrade] Action before: ${JSON.stringify({ actionId: action.actionId, options: action.options })}`,
			)
			logger.debug(
				`[DiGiCo upgrade] Action after:  ${JSON.stringify({ actionId: updated.actionId, options: updated.options })}\n`,
			)
		}
		return updated ? [updated] : []
	})
	const tableRows = loadCommandTable()
	const updatedFeedbacks = props.feedbacks.flatMap((feedback) => {
		const updated = migrateFeedback(feedback, tableRows)
		return updated ? [updated] : []
	})
	const oldConfig = props.config as
		(Partial<ModuleConfig> & { host?: unknown; port?: unknown; receiveport?: unknown }) | null
	let updatedConfig: ModuleConfig | null = null
	if (oldConfig && oldConfig.ip === undefined && typeof oldConfig.host === 'string' && oldConfig.host.trim()) {
		updatedConfig = {
			...DEFAULT_CONFIG,
			ip: oldConfig.host.trim(),
			transmitPort: Number(oldConfig.port) || DEFAULT_CONFIG.transmitPort,
			receivePort: Number(oldConfig.receiveport) || DEFAULT_CONFIG.receivePort,
		}
	}

	return { updatedConfig, updatedActions, updatedFeedbacks }
}

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = [upgradeLegacyDiGiCoControls]
