import {
	InstanceBase,
	InstanceStatus,
	type JsonValue,
	type OSCSomeArguments,
	type SomeCompanionConfigField,
	createModuleLogger,
} from '@companion-module/base'
import { DEFAULT_CONFIG, GetConfigFields, type ModuleConfig } from './config.js'
import { IncomingActionRecorder } from './actionRecorder.js'
import {
	PARAMETER_MAXIMUMS,
	UpdateVariableDefinitions,
	type ParameterMaximumKey,
	type VariablesSchema,
} from './variables.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import {
	getPathAxisLabel,
	getPathOptionNameTemplate,
	getPathParameterDefault,
	getPathParameterKey,
	loadCommandTable,
	pathMatcher,
	type CommandRow,
} from './commandTable.js'
import { createMixer, type digico } from './mixers.js'
import { IpadRelay } from './ipadRelay.js'
import { OSC_QUERY_TIMEOUT_MS, type OSCValue } from './osc.js'
export { UpgradeScripts } from './upgrades.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: undefined
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

const logger = createModuleLogger('main')
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
type EntityListKind = 'snapshot' | 'preset' | 'macro'

function entityListMutation(path: string): EntityListKind | undefined {
	if (/^\/Snapshots\/(New_Snapshot|Insert_New_Snapshot|Move_Snapshot|Rename_Snapshot|Delete_Snapshot|Renumber_Snapshot|Update_Snapshot(?:_Group)?|Update_Current_Snapshot)(?:\/|$)/.test(path)) {
		return 'snapshot'
	}
	if (/^\/Presets\/(New_Preset|Delete_Preset|Lock_Preset|Rename_Preset(?:_Group)?)(?:\/|$)/.test(path)) {
		return 'preset'
	}
	if (/^\/Macros\/(New|Create|Delete|Rename|Move|Update|Save)_Macro(?:\/|$)/.test(path)) return 'macro'
	return undefined
}

type SnapshotNote = { note: string }
type SnapshotInfo = { index: number; num: string; group: number; name: string }
type MacroInfo = { index: number; name: string }
type PresetInfo = {
	index: number
	channelCount: number
	unknown: number
	section: string
	group: string
	name: string
}

function truncateOscFloat(value: OSCValue): OSCValue {
	if (typeof value !== 'number' || !Number.isFinite(value)) return value
	return Math.trunc(value * 1_000_000) / 1_000_000
}

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config!: ModuleConfig
	private commandRows: CommandRow[] = []
	private mixer: digico | undefined
	private ipadRelay: IpadRelay | undefined
	private readonly oscValues = new Map<string, JsonValue>()
	private readonly snapshotNotes = new Map<number, SnapshotNote>()
	private readonly snapshotInfos = new Map<number, SnapshotInfo>()
	private readonly macroInfos = new Map<number, MacroInfo>()
	private readonly presetInfos = new Map<number, PresetInfo>()
	private readonly macroButtonStates = new Map<number, { state: number; name: string }>()
	private readonly macroNamesByRecallIndex = new Map<number, string>()
	private readonly feedbackQueries = new Map<string, string>()
	private readonly feedbackQueryTargets = new Map<string, string>()
	private readonly sentFeedbackQueries = new Set<string>()
	private readonly pendingValueReads = new Map<string, Promise<JsonValue | undefined>>()
	private readonly queriedNamePaths = new Set<string>()
	private readonly actionRecorder = new IncomingActionRecorder((action, uniqueId) =>
		this.recordAction(action, uniqueId),
	)
	private actionRefreshTimer: ReturnType<typeof setTimeout> | undefined
	private readonly entityListRefreshTimers = new Map<EntityListKind, ReturnType<typeof setTimeout>>()
	private readonly parameterMaximums = new Map<ParameterMaximumKey, number>()
	private parameterDiscoveryComplete = false
	private parameterDiscoveryGeneration = 0

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = this.normalizeConfig(config)
		this.commandRows = loadCommandTable()
		this.updateVariableDefinitions()
		this.publishParameterMaximums()
		this.setVariableValues({ filename: '' })
		this.startMixer()
	}

	async destroy(): Promise<void> {
		await this.stopRuntime()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		await this.stopRuntime()
		logger.debug('Configuration updated; restarting OSC transport')
		this.resetConnectionState()
		this.config = this.normalizeConfig(config)
		this.commandRows = loadCommandTable()
		this.startMixer()
	}

	private async stopRuntime(): Promise<void> {
		this.parameterDiscoveryGeneration++
		this.clearPendingValueReads()
		if (this.actionRefreshTimer) clearTimeout(this.actionRefreshTimer)
		this.actionRefreshTimer = undefined
		for (const timer of this.entityListRefreshTimers.values()) clearTimeout(timer)
		this.entityListRefreshTimers.clear()
		await this.ipadRelay?.destroy()
		this.ipadRelay = undefined
		await this.mixer?.destroy()
		this.mixer = undefined
	}

	private resetConnectionState(): void {
		this.oscValues.clear()
		this.macroButtonStates.clear()
		this.macroNamesByRecallIndex.clear()
		this.macroInfos.clear()
		this.presetInfos.clear()
		this.feedbackQueries.clear()
		this.feedbackQueryTargets.clear()
		this.sentFeedbackQueries.clear()
		this.snapshotNotes.clear()
		this.snapshotInfos.clear()
		this.queriedNamePaths.clear()
		this.parameterMaximums.clear()
		this.parameterDiscoveryComplete = false
		this.publishParameterMaximums()
		this.setVariableValues({ filename: '' })
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	public send_osc(path: string, args: OSCSomeArguments): void {
		this.mixer?.sendOsc(path, args)
	}

	public runOscQuery(path: string): Promise<boolean> {
		return this.mixer?.queryOsc(path) ?? Promise.resolve(false)
	}

	public forwardConsoleOscPacket(packet: Buffer): void {
		this.ipadRelay?.forwardConsolePacket(packet)
	}

	public getOscValue(path: string): JsonValue | undefined {
		return this.oscValues.get(path)
	}

	public getParameterChoices(
		row: CommandRow,
		axis: number,
		defaultValue: number,
	): Array<{ id: number | string; label: string }> {
		if (row.parameterKey === 'Recall_Macro') {
			const macroMax = this.parameterMaximums.get('recall_macro') ?? -1
			return [
				{ id: 'all', label: 'All' },
				...Array.from({ length: Math.max(0, macroMax + 1) }, (_, index) => ({
					id: index,
					label: `${index}: ${this.macroInfos.get(index)?.name || this.macroNamesByRecallIndex.get(index) || this.macroButtonStates.get(index)?.name || `Macro ${index}`}`,
				})),
			]
		}
		const parameterKey = getPathParameterKey(row.oscPath, axis)
		const parameterMaximum = parameterKey ? this.parameterMaximums.get(parameterKey as ParameterMaximumKey) : undefined
		const parameterMinimum = getPathParameterDefault(row.oscPath, axis)
		const matcher = pathMatcher(row.oscPath)
		const availableIndexes = new Set<number>()
		for (const path of this.oscValues.keys()) {
			const match = path.match(matcher)
			const value = Number(match?.[axis + 1])
			if (Number.isInteger(value)) availableIndexes.add(value)
		}
		const nameTemplate = getPathOptionNameTemplate(row.oscPath, axis)
		const names = new Map<number, string>()
		if (nameTemplate) {
			const nameMatcher = pathMatcher(nameTemplate)
			for (const [path, value] of this.oscValues) {
				const match = path.match(nameMatcher)
				const index = Number(match?.[1])
				if (Number.isInteger(index) && typeof value === 'string') {
					names.set(index, value)
					availableIndexes.add(index)
				}
			}
		}
		if (parameterMaximum !== undefined) {
			for (let index = parameterMinimum; index <= parameterMaximum; index++) availableIndexes.add(index)
		}
		for (const index of [...availableIndexes])
			if (index < parameterMinimum || index > (parameterMaximum ?? -1)) availableIndexes.delete(index)
		if (availableIndexes.size === 0 && parameterMaximum === undefined) availableIndexes.add(defaultValue)
		const choices: Array<{ id: number | string; label: string }> = [{ id: 'all', label: 'All' }]
		for (const index of [...availableIndexes].sort((a, b) => a - b)) {
			const snapshotInfo = row.oscPath.startsWith('/Snapshots/') ? this.snapshotInfos.get(index) : undefined
			const presetInfo = row.oscPath.startsWith('/Presets/') ? this.presetInfos.get(index) : undefined
			const label = snapshotInfo
				? `${snapshotInfo.index}: [${snapshotInfo.num}] ${snapshotInfo.name}`
				: presetInfo
					? `${presetInfo.index}: [${presetInfo.section}] ${presetInfo.group ? `${presetInfo.group}/` : ''}${presetInfo.name}`
					: `${index}: ${names.get(index) || this.parameterFallbackName(row, axis, index)}`
			choices.push({ id: index, label })
		}
		return choices
	}

	public handleStartStopRecordActions(isRecording: boolean): void {
		this.actionRecorder.setRecording(isRecording)
		logger.debug(`Action recorder ${isRecording ? 'started' : 'stopped'}`)
	}

	public getMacroButtonState(macroNumber: number): number | undefined {
		return this.macroButtonStates.get(macroNumber)?.state
	}

	public getMacroButtonName(macroNumber: number): string | undefined {
		return this.macroButtonStates.get(macroNumber)?.name
	}

	public getMacroMaximum(): number {
		return Math.max(0, this.parameterMaximums.get('recall_macro') ?? 255)
	}

	public getSnapshotNote(snapshot: number): string | undefined {
		return this.snapshotNotes.get(snapshot)?.note
	}

	public getNamedValue(path: string, index: number): JsonValue | undefined {
		if (path === '/Snapshots/name') return this.snapshotInfos.get(index)
		if (path === '/Macros/name') return this.macroInfos.get(index)
		if (path === '/Presets/name') return this.presetInfos.get(index)
		return undefined
	}

	public getNamedValueChoices(path: string): Array<{ id: number; label: string }> {
		if (path === '/Snapshots/name') {
			return [...this.snapshotInfos.values()]
				.sort((a, b) => a.index - b.index)
				.map((info) => ({ id: info.index, label: `${info.index}: [${info.num}] ${info.name}` }))
		}
		if (path === '/Macros/name') {
			return [...this.macroInfos.values()]
				.sort((a, b) => a.index - b.index)
				.map((info) => ({ id: info.index, label: `${info.index}: ${info.name}` }))
		}
		if (path === '/Presets/name') {
			return [...this.presetInfos.values()]
				.sort((a, b) => a.index - b.index)
				.map((info) => ({
					id: info.index,
					label: `${info.index}: [${info.section}] ${info.group ? `${info.group}/` : ''}${info.name}`,
				}))
		}
		return []
	}

	public getPresetSections(): string[] {
		return [...new Set([...this.presetInfos.values()].map((info) => info.section.trim()).filter(Boolean))].sort(
			(a, b) => a.localeCompare(b),
		)
	}

	public getPresetChoicesForSection(section: string): Array<{ id: number; label: string }> {
		return this.getNamedValueChoices('/Presets/name').filter(
			(choice) => this.presetInfos.get(choice.id)?.section.trim() === section,
		)
	}

	public getPresetTargetChoices(section: string): Array<{ id: number; label: string }> {
		const sectionKey = section.trim().replace(/\s+/g, '_').toLowerCase()
		if (sectionKey === 'fx') {
			return Array.from({ length: 16 }, (_, index) => ({ id: index + 1, label: `${index + 1}: FX ${index + 1}` }))
		}
		const selectorPaths: Record<string, string> = {
			input_channels: '/Input_Channels/*/Channel_Input/name',
			aux_outputs: '/Aux_Outputs/*/Buss_Trim/name',
			aux_mix: '/Aux_Outputs/*/Buss_Trim/name',
			group_outputs: '/Group_Outputs/*/Buss_Trim/name',
			talkback_outputs: '/Talkback_Outputs/*/name',
			matrix_inputs: '/Matrix_Inputs/*/Channel_Input/name',
			matrix_outputs: '/Matrix_Outputs/*/Buss_Trim/name',
			graphic_eq: '/Graphic_EQ/*/name',
			control_groups: '/Control_Groups/*/name',
			multis: '/Multis/*/name',
		}
		const selectorPath = selectorPaths[sectionKey]
		if (!selectorPath) return []
		const selectorRow: CommandRow = {
			name: section,
			oscPath: selectorPath,
			parameterKey: '',
			dataType: 'Int',
			min: undefined,
			max: undefined,
			units: '',
			rw: 'R',
			description: '',
			valueFeedback: '',
		}
		return this.getParameterChoices(selectorRow, 0, 1).filter(
			(choice): choice is { id: number; label: string } => typeof choice.id === 'number',
		)
	}

	public getPresetGroupChoices(section: string): Array<{ id: string; label: string }> {
		const groups = new Map<string, { section: string; group: string }>()
		for (const info of this.presetInfos.values()) {
			if (info.section.trim() !== section) continue
			const key = JSON.stringify([info.section, info.group])
			groups.set(key, { section: info.section, group: info.group })
		}
		return [...groups.entries()]
			.sort(([, a], [, b]) => a.group.localeCompare(b.group))
			.map(([id, { group }]) => ({
				id,
				label: group || '(No Group)',
			}))
	}

	public getPresetGroupRenameChoices(): Array<{ id: number; label: string }> {
		const groups = new Map<string, { index: number; section: string; group: string }>()
		for (const info of this.presetInfos.values()) {
			const key = JSON.stringify([info.section, info.group])
			const existing = groups.get(key)
			if (!existing || info.index < existing.index) {
				groups.set(key, { index: info.index, section: info.section, group: info.group })
			}
		}
		return [...groups.values()]
			.sort((a, b) => a.section.localeCompare(b.section) || a.group.localeCompare(b.group))
			.map(({ index, section, group }) => ({
				id: index,
				label: `${section}: ${group || '(No Group)'}`,
			}))
	}

	public getPresetIndexes(): number[] {
		return [...this.presetInfos.keys()]
	}

	public getNewPresetIndex(previousIndexes: number[]): number | undefined {
		const previous = new Set(previousIndexes)
		return [...this.presetInfos.keys()].filter((index) => !previous.has(index)).sort((a, b) => b - a)[0]
	}

	public async refreshSnapshotData(): Promise<void> {
		await delay(100)
		const generation = this.parameterDiscoveryGeneration
		if (!this.mixer) return
		await this.mixer.queryOsc('/Snapshots/count', undefined, 1000)
		if (generation !== this.parameterDiscoveryGeneration) return
		const countValue = this.oscValues.get('/Snapshots/count')
		const snapshotTotal =
			typeof countValue === 'number' && Number.isFinite(countValue) ? Math.max(0, Math.trunc(countValue)) : 0
		this.parameterMaximums.set('snapshot', Math.max(0, snapshotTotal - 1))
		await this.loadSnapshotInfoList(snapshotTotal, generation)
		if (generation !== this.parameterDiscoveryGeneration) return
		this.publishParameterMaximums()
		this.updateActions()
		this.updateFeedbacks()
	}

	public async refreshPresetData(): Promise<void> {
		await delay(100)
		const generation = this.parameterDiscoveryGeneration
		if (!this.mixer) return
		await this.mixer.queryOsc('/Presets/count', undefined, 1000)
		if (generation !== this.parameterDiscoveryGeneration) return
		const count = this.oscValues.get('/Presets/count')
		const total = typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
		this.parameterMaximums.set('presets', Math.max(-1, total - 1))
		await this.loadPresetInfoList(total, generation)
		if (generation !== this.parameterDiscoveryGeneration) return
		this.publishParameterMaximums()
		this.updateActions()
		this.updateFeedbacks()
	}

	public async refreshMacroData(): Promise<void> {
		await delay(100)
		const generation = this.parameterDiscoveryGeneration
		if (!this.mixer) return
		await this.mixer.queryOsc('/Macros/count', undefined, 1000)
		if (generation !== this.parameterDiscoveryGeneration) return
		const count = this.oscValues.get('/Macros/count')
		const total = typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
		this.parameterMaximums.set('recall_macro', Math.max(-1, total - 1))
		await this.loadMacroInfoList(total, generation)
		if (generation !== this.parameterDiscoveryGeneration) return
		this.publishParameterMaximums()
		this.updateActions()
		this.updateFeedbacks()
	}

	public async getOscValueOrQuery(path: string, timeoutMs = OSC_QUERY_TIMEOUT_MS): Promise<JsonValue | undefined> {
		if (this.oscValues.has(path)) return this.oscValues.get(path)
		if (!this.mixer) return undefined
		const pending = this.pendingValueReads.get(path)
		if (pending) return pending
		const request = this.mixer.queryOsc(path, undefined, timeoutMs).then(() => this.oscValues.get(path))
		this.pendingValueReads.set(path, request)
		try {
			return await request
		} finally {
			if (this.pendingValueReads.get(path) === request) this.pendingValueReads.delete(path)
		}
	}

	private clearPendingValueReads(): void {
		this.pendingValueReads.clear()
	}

	public watchFeedbackValue(feedbackId: string, path: string, queryPath = path, queryIndex?: number): void {
		const previousTarget = this.feedbackQueryTargets.get(feedbackId)
		const queryTarget = `${queryPath}|${queryIndex ?? ''}`
		if (
			previousTarget &&
			previousTarget !== queryTarget &&
			![...this.feedbackQueryTargets.values()].includes(previousTarget)
		) {
			this.sentFeedbackQueries.delete(previousTarget)
		}
		this.feedbackQueries.set(feedbackId, path)
		this.feedbackQueryTargets.set(feedbackId, queryTarget)
		const cached =
			queryPath === '/Snapshots/notes'
				? this.snapshotNotes.has(queryIndex ?? 0)
				: ['/Snapshots/name', '/Macros/name', '/Presets/name'].includes(queryPath)
					? this.getNamedValue(queryPath, queryIndex ?? 0) !== undefined
					: this.oscValues.has(queryPath)
		if (previousTarget === queryTarget || cached || !this.mixer || this.sentFeedbackQueries.has(queryTarget)) return
		this.sentFeedbackQueries.add(queryTarget)
		this.mixer.queryOsc(queryPath, queryIndex)
	}

	public releaseFeedbackValue(feedbackId: string): void {
		this.feedbackQueries.delete(feedbackId)
		const target = this.feedbackQueryTargets.get(feedbackId)
		this.feedbackQueryTargets.delete(feedbackId)
		if (target && ![...this.feedbackQueryTargets.values()].includes(target)) this.sentFeedbackQueries.delete(target)
	}

	public shouldSuppressIpadFilenameReply(path: string): boolean {
		return this.ipadRelay?.shouldSuppressFilenameReply(path) ?? false
	}

	public onOscMessage(path: string, args: OSCValue[]): void {
		const suppressedIpadFilenameReply = this.shouldSuppressIpadFilenameReply(path)
		if (suppressedIpadFilenameReply) this.ipadRelay?.consumeFilenameReply(path)
		const incomingArgs = args.map(truncateOscFloat)
		if (path === '/Snapshots/notes' && typeof incomingArgs[0] === 'number' && typeof incomingArgs[4] === 'string') {
			this.snapshotNotes.set(Math.trunc(incomingArgs[0]), { note: incomingArgs[4] })
		}
		const snapshotInfo =
			path === '/Snapshots/name' &&
			typeof incomingArgs[0] === 'number' &&
			typeof incomingArgs[1] === 'number' &&
			typeof incomingArgs[2] === 'number' &&
			typeof incomingArgs[3] === 'string'
				? {
						index: Math.trunc(incomingArgs[0]),
						num: (incomingArgs[1] / 100).toFixed(2),
						group: Math.trunc(incomingArgs[2]),
						name: incomingArgs[3],
					}
				: undefined
		if (snapshotInfo) this.snapshotInfos.set(snapshotInfo.index, snapshotInfo)
		const macroInfo =
			path === '/Macros/name' && typeof incomingArgs[0] === 'number' && typeof incomingArgs[1] === 'string'
				? { index: Math.trunc(incomingArgs[0]), name: incomingArgs[1] }
				: undefined
		if (macroInfo) {
			this.macroInfos.set(macroInfo.index, macroInfo)
			this.macroNamesByRecallIndex.set(macroInfo.index, macroInfo.name)
		}
		const presetInfo =
			path === '/Presets/name' &&
			typeof incomingArgs[0] === 'number' &&
			typeof incomingArgs[1] === 'number' &&
			typeof incomingArgs[2] === 'number' &&
			typeof incomingArgs[3] === 'string' &&
			typeof incomingArgs[4] === 'string' &&
			typeof incomingArgs[5] === 'string'
				? {
						index: Math.trunc(incomingArgs[0]),
						channelCount: Math.trunc(incomingArgs[1]),
						unknown: Math.trunc(incomingArgs[2]),
						section: incomingArgs[3],
						group: incomingArgs[4],
						name: incomingArgs[5],
					}
				: undefined
		if (presetInfo) this.presetInfos.set(presetInfo.index, presetInfo)
		const previousValue = this.oscValues.get(path)
		const value = incomingArgs[0]
		let macroNamesChanged = false
		if (
			path === '/Macros/Buttons/state' &&
			typeof incomingArgs[0] === 'number' &&
			typeof incomingArgs[1] === 'number' &&
			typeof incomingArgs[2] === 'string'
		) {
			macroNamesChanged = this.macroButtonStates.get(incomingArgs[0])?.name !== incomingArgs[2]
			this.macroButtonStates.set(incomingArgs[0], { state: incomingArgs[1], name: incomingArgs[2] })
			this.macroNamesByRecallIndex.set(incomingArgs[0], incomingArgs[2])
		}
		const cachedValue: JsonValue | undefined =
			snapshotInfo || macroInfo || presetInfo
				? (snapshotInfo ?? macroInfo ?? presetInfo)!
				: (path === '/Macros/Buttons/state' || path.endsWith('/modes')) && incomingArgs.length > 0
					? incomingArgs.map((arg) => (arg instanceof Uint8Array ? Buffer.from(arg).toString('base64') : arg))
					: typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' || value === null
						? value
						: value instanceof Uint8Array
							? Buffer.from(value).toString('base64')
							: undefined
		const valueChanged = cachedValue !== undefined && JSON.stringify(previousValue) !== JSON.stringify(cachedValue)
		if (cachedValue !== undefined) {
			this.oscValues.set(path, cachedValue)
			if (!suppressedIpadFilenameReply) logger.debug(`Cached OSC value ${path} = ${JSON.stringify(cachedValue)}`)
			if (path === '/Console/Session/Filename' && typeof cachedValue === 'string') {
				this.setVariableValues({ filename: cachedValue })
			}
		} else if (value instanceof Uint8Array) {
			logger.warn(`OSC value for ${path} could not be cached`)
		} else {
			logger.warn(`OSC value for ${path} has unsupported type: ${typeof value}`)
		}
		if (cachedValue !== undefined && path.endsWith('/name') && previousValue !== cachedValue)
			this.scheduleActionRefresh()
		if (macroNamesChanged) this.scheduleActionRefresh()
		const feedbackIds = [...this.feedbackQueries]
			.filter(([, feedbackPath]) => feedbackPath === path)
			.map(([feedbackId]) => feedbackId)
		if (valueChanged && feedbackIds.length > 0) {
			logger.debug(`Refreshing ${feedbackIds.length} feedback instance(s) for ${path}`)
			this.checkFeedbacksById(...feedbackIds)
		}
		this.actionRecorder.record(path, incomingArgs, this.commandRows)
		const listKind = entityListMutation(path)
		if (listKind) this.scheduleEntityListRefresh(listKind)
	}

	private parameterFallbackName(row: CommandRow, axis: number, index: number): string {
		const axisLabel = getPathOptionNameTemplate(row.oscPath, axis)?.split('/')[1]
		if (axisLabel === 'Input_Channels') return `Ch ${index}`
		if (axisLabel === 'Aux_Outputs') return `Aux ${index}`
		if (axisLabel === 'Group_Outputs') return `Group ${index}`
		if (axisLabel === 'Talkback_Outputs') return `Talkback ${index}`
		if (axisLabel === 'Matrix_Outputs') return `Matrix ${index}`
		if (axisLabel === 'Control_Groups') return `Control Group ${index}`
		return `${getPathAxisLabel(row.oscPath, axis)} ${index}`
	}

	private scheduleActionRefresh(): void {
		if (!this.parameterDiscoveryComplete) return
		if (this.actionRefreshTimer) clearTimeout(this.actionRefreshTimer)
		this.actionRefreshTimer = setTimeout(() => {
			this.actionRefreshTimer = undefined
			this.updateActions()
			this.updateFeedbacks()
		}, 100)
	}

	private scheduleEntityListRefresh(kind: EntityListKind): void {
		const existing = this.entityListRefreshTimers.get(kind)
		if (existing) clearTimeout(existing)
		const timer = setTimeout(() => {
			this.entityListRefreshTimers.delete(kind)
			const refresh =
				kind === 'snapshot'
					? this.refreshSnapshotData()
					: kind === 'preset'
						? this.refreshPresetData()
						: this.refreshMacroData()
			void refresh.catch((error) => logger.warn(`Unable to refresh ${kind} list: ${String(error)}`))
		}, 150)
		this.entityListRefreshTimers.set(kind, timer)
	}

	private normalizeConfig(config: Partial<ModuleConfig> | undefined): ModuleConfig {
		return {
			...DEFAULT_CONFIG,
			ip: config?.ip?.trim() || DEFAULT_CONFIG.ip,
			transmitPort: Number(config?.transmitPort) || DEFAULT_CONFIG.transmitPort,
			receivePort: Number(config?.receivePort) || DEFAULT_CONFIG.receivePort,
			ipadEnabled: config?.ipadEnabled ?? DEFAULT_CONFIG.ipadEnabled,
			ipadIp: config?.ipadIp?.trim() || DEFAULT_CONFIG.ipadIp,
			ipadTransmitPort: Number(config?.ipadTransmitPort) || DEFAULT_CONFIG.ipadTransmitPort,
			ipadReceivePort: Number(config?.ipadReceivePort) || DEFAULT_CONFIG.ipadReceivePort,
		}
	}

	private startMixer(): void {
		try {
			if (this.config.ipadEnabled && this.config.ipadReceivePort === this.config.receivePort) {
				logger.error(
					`iPad receive port ${this.config.ipadReceivePort} must differ from console receive port ${this.config.receivePort}`,
				)
			} else if (this.config.ipadEnabled) {
				try {
					this.ipadRelay = new IpadRelay(this, this.config)
				} catch (error) {
					logger.error(`Unable to start iPad OSC relay: ${String(error)}`)
				}
			}
			this.mixer = createMixer(this, this.config)
			this.updateStatus(InstanceStatus.Ok)
			const generation = ++this.parameterDiscoveryGeneration
			void this.discoverParameterMaximums(generation)
		} catch (error) {
			this.updateStatus(InstanceStatus.UnknownError, String(error))
			logger.error(`Unable to start OSC transport: ${String(error)}`)
		}
	}

	private async discoverParameterMaximums(generation: number): Promise<void> {
		void this.getOscValueOrQuery('/Console/Session/Filename').catch((error) => {
			logger.debug(`Unable to query console session filename: ${String(error)}`)
		})
		// /Console/Channels/? reports the available counts for all console sections.
		// Its replies are sibling addresses, so mixers.ts treats any /Console/* reply
		// as the response to this aggregate query.
		if (this.mixer) {
			await this.mixer.queryOsc('/Console/Channels', undefined, 500)
			await delay(50) // allow the console's count replies to arrive as separate datagrams
		}
		if (generation !== this.parameterDiscoveryGeneration) return

		type DiscoverableKey = Exclude<
			ParameterMaximumKey,
			'aux_send' | 'group_send' | 'matrix_send' | 'recall_macro' | 'presets' | 'snapshot' | 'talkback_outputs'
		>
		const parameterQueries: Record<
			DiscoverableKey,
			{ countPath: string; maximum: number; path: (index: number) => string }
		> = {
			input_channels: {
				countPath: '/Console/Input_Channels',
				maximum: 512,
				path: (index) => `/Input_Channels/${index}/Channel_Input/name`,
			},
			aux_outputs: {
				countPath: '/Console/Aux_Outputs',
				maximum: 512,
				path: (index) => `/Aux_Outputs/${index}/Buss_Trim/name`,
			},
			group_outputs: {
				countPath: '/Console/Group_Outputs',
				maximum: 512,
				path: (index) => `/Group_Outputs/${index}/Buss_Trim/name`,
			},
			matrix_inputs: {
				countPath: '/Console/Matrix_Inputs',
				maximum: 512,
				path: (index) => `/Matrix_Inputs/${index}/Channel_Input/name`,
			},
			matrix_outputs: {
				countPath: '/Console/Matrix_Outputs',
				maximum: 512,
				path: (index) => `/Matrix_Outputs/${index}/Buss_Trim/name`,
			},
			control_groups: {
				countPath: '/Console/Control_Groups',
				maximum: 512,
				path: (index) => `/Control_Groups/${index}/name`,
			},
			graphic_eq: { countPath: '/Console/Graphic_EQ', maximum: 512, path: (index) => `/Graphic_EQ/${index}/name` },
			multis: { countPath: '/Console/Multis', maximum: 512, path: (index) => `/Multis/${index}/name` },
		}
		const parameterKeys: DiscoverableKey[] = [
			'input_channels',
			'aux_outputs',
			'group_outputs',
			'matrix_inputs',
			'matrix_outputs',
			'control_groups',
			'graphic_eq',
			'multis',
		]
		const discovered = await Promise.all(
			parameterKeys.map(async (key) => {
				const definition = parameterQueries[key]
				const reportedCount = this.oscValues.get(definition.countPath)
				const maximum =
					typeof reportedCount === 'number' && Number.isFinite(reportedCount)
						? Math.max(0, Math.min(definition.maximum, Math.trunc(reportedCount)))
						: await this.discoverSequentialMaximum(definition, generation)
				if (typeof reportedCount === 'number') {
					for (let index = 1; index <= maximum && generation === this.parameterDiscoveryGeneration; index++) {
						await this.getOscValueOrQuery(definition.path(index))
					}
				}
				return [key, maximum] as const
			}),
		)
		if (generation !== this.parameterDiscoveryGeneration) return
		for (const [key, maximum] of discovered) this.parameterMaximums.set(key, maximum)
		const talkbackCount = this.oscValues.get('/Console/Talkback_Outputs')
		this.parameterMaximums.set(
			'talkback_outputs',
			typeof talkbackCount === 'number' && Number.isFinite(talkbackCount)
				? Math.max(0, Math.min(512, Math.trunc(talkbackCount)))
				: 0,
		)
		const macroCount = await this.getOscValueOrQuery('/Macros/count')
		const macroTotal =
			typeof macroCount === 'number' && Number.isFinite(macroCount) ? Math.max(0, Math.trunc(macroCount)) : 0
		this.parameterMaximums.set('recall_macro', Math.max(-1, macroTotal - 1))
		await this.loadMacroInfoList(macroTotal, generation)
		if (generation !== this.parameterDiscoveryGeneration) return
		const presetCount = await this.getOscValueOrQuery('/Presets/count')
		const presetTotal =
			typeof presetCount === 'number' && Number.isFinite(presetCount) ? Math.max(0, Math.trunc(presetCount)) : 0
		this.parameterMaximums.set('presets', Math.max(-1, presetTotal - 1))
		await this.loadPresetInfoList(presetTotal, generation)
		if (generation !== this.parameterDiscoveryGeneration) return
		this.parameterMaximums.set('aux_send', this.parameterMaximums.get('aux_outputs') ?? 0)
		this.parameterMaximums.set('group_send', this.parameterMaximums.get('group_outputs') ?? 0)
		this.parameterMaximums.set('matrix_send', this.parameterMaximums.get('matrix_outputs') ?? 0)
		const snapshotCount = await this.getOscValueOrQuery('/Snapshots/count')
		if (generation !== this.parameterDiscoveryGeneration) return
		const snapshotTotal =
			typeof snapshotCount === 'number' && Number.isFinite(snapshotCount) ? Math.max(0, Math.trunc(snapshotCount)) : 0
		this.parameterMaximums.set('snapshot', Math.max(0, snapshotTotal - 1))
		await this.loadSnapshotInfoList(snapshotTotal, generation)
		if (generation !== this.parameterDiscoveryGeneration) return
		this.publishParameterMaximums()
		this.parameterDiscoveryComplete = true
		logger.debug(`Discovered parameter maxima: ${JSON.stringify(Object.fromEntries(this.parameterMaximums))}`)
		this.updateActions()
		this.updateFeedbacks()
	}

	private async loadSnapshotInfoList(snapshotTotal: number, generation: number): Promise<void> {
		this.snapshotInfos.clear()
		if (snapshotTotal > 0 && this.mixer) {
			await this.mixer.queryOsc('/Snapshots/names', undefined, 1000)
			await this.waitForSnapshotInfoCount(snapshotTotal, generation)
			logger.debug(`Loaded ${this.snapshotInfos.size}/${snapshotTotal} snapshot records`)
		}
	}

	private async loadMacroInfoList(total: number, generation: number): Promise<void> {
		this.macroInfos.clear()
		this.macroNamesByRecallIndex.clear()
		if (total > 0 && this.mixer) {
			await this.mixer.queryOsc('/Macros/names', undefined, 1000)
			await this.waitForItemCount(this.macroInfos, total, generation)
			logger.debug(`Loaded ${this.macroInfos.size}/${total} macro records`)
		}
	}

	private async loadPresetInfoList(total: number, generation: number): Promise<void> {
		this.presetInfos.clear()
		if (total > 0 && this.mixer) {
			await this.mixer.queryOsc('/Presets/names', undefined, 1000)
			await this.waitForItemCount(this.presetInfos, total, generation)
			logger.debug(`Loaded ${this.presetInfos.size}/${total} preset records`)
		}
	}

	private async waitForItemCount<T>(
		items: Map<number, T>,
		expectedCount: number,
		generation: number,
	): Promise<void> {
		const deadline = Date.now() + 2000
		while (generation === this.parameterDiscoveryGeneration && items.size < expectedCount && Date.now() < deadline) {
			await delay(10)
		}
	}

	private async waitForSnapshotInfoCount(expectedCount: number, generation: number): Promise<void> {
		const deadline = Date.now() + 2000
		while (
			generation === this.parameterDiscoveryGeneration &&
			this.snapshotInfos.size < expectedCount &&
			Date.now() < deadline
		) {
			await delay(10)
		}
	}

	private async discoverSequentialMaximum(
		definition: { maximum: number; path: (index: number) => string },
		generation: number,
	): Promise<number> {
		let maximum = 0
		for (let index = 1; index <= definition.maximum; index++) {
			if (generation !== this.parameterDiscoveryGeneration) break
			const path = definition.path(index)
			const value = await this.getOscValueOrQuery(path)
			if (value === undefined || value === null) break
			maximum = index
		}
		return maximum
	}

	private publishParameterMaximums(): void {
		const values: Record<string, string> = {}
		for (const [key] of Object.entries(PARAMETER_MAXIMUMS) as Array<[ParameterMaximumKey, string]>) {
			const maximum = this.parameterMaximums.get(key)
			values[key] =
				maximum === undefined ? '' : String(key === 'recall_macro' || key === 'presets' ? maximum + 1 : maximum)
		}
		this.setVariableValues(values)
	}

	updateActions(): void {
		UpdateActions(this, this.commandRows)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this, this.commandRows)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}
}
