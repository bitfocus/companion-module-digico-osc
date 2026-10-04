import type {
	CompanionMigrationAction,
	CompanionMigrationFeedback,
	CompanionStaticUpgradeProps,
	CompanionStaticUpgradeResult,
	CompanionStaticUpgradeScript,
	CompanionUpgradeContext,
} from '@companion-module/base'
import type { ModuleConfig } from './config.js'

type LegacyActionMapping = {
	actionId: string
	options: Record<string, string>
	convertNumericStrings?: string[]
}

const legacyActions: Record<string, LegacyActionMapping> = {
	snapshotNext: { actionId: '/Snapshots/Fire_Next_Snapshot', options: {} },
	snapshotPrev: { actionId: '/Snapshots/Fire_Prev_Snapshot', options: {} },
	snapshot: { actionId: '/Snapshots/Recall_Snapshot/*', options: { snapshot: 'index_1' } },
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

function isWrappedValue(value: unknown): value is { value: unknown; isExpression: boolean } {
	return typeof value === 'object' && value !== null && 'value' in value && 'isExpression' in value
}

function migrateAction(action: CompanionMigrationAction): CompanionMigrationAction | undefined {
	const mapping = legacyActions[action.actionId]
	if (!mapping) return undefined

	const options: CompanionMigrationAction['options'] = {}
	for (const [oldKey, newKey] of Object.entries(mapping.options)) {
		const oldValue = action.options[oldKey]
		if (oldValue === undefined) continue

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

	return { ...action, actionId: mapping.actionId, options }
}

function migrateFeedback(feedback: CompanionMigrationFeedback): CompanionMigrationFeedback | undefined {
	if (feedback.feedbackId !== 'macroStatus') return undefined

	const macro = feedback.options.macro
	return {
		...feedback,
		feedbackId: '/Macros/Buttons/state/name',
		options: macro === undefined ? {} : { macro },
	}
}

function upgradeLegacyDiGiCoControls(
	_context: CompanionUpgradeContext<ModuleConfig>,
	props: CompanionStaticUpgradeProps<ModuleConfig, undefined>,
): CompanionStaticUpgradeResult<ModuleConfig, undefined> {
	const updatedActions = props.actions.flatMap((action) => {
		const updated = migrateAction(action)
		if (updated) {
			console.log(
				`[DiGiCo upgrade] Action before: ${JSON.stringify({ actionId: action.actionId, options: action.options })}`,
			)
			console.log(
				`[DiGiCo upgrade] Action after:  ${JSON.stringify({ actionId: updated.actionId, options: updated.options })}\n`,
			)
		}
		return updated ? [updated] : []
	})
	const updatedFeedbacks = props.feedbacks.flatMap((feedback) => {
		const updated = migrateFeedback(feedback)
		return updated ? [updated] : []
	})

	return { updatedConfig: null, updatedActions, updatedFeedbacks }
}

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = [upgradeLegacyDiGiCoControls]
