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
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { getPathAxisLabel, getPathAxisSegment, loadCommandTable, pathMatcher, type CommandRow } from './commandTable.js'
import { deriveSelectorProviders, selectorProviderForSegment, type SelectorProvider } from './selectorProviders.js'
import { createMixer, type digico } from './mixers.js'
import { IpadRelay } from './ipadRelay.js'
import { OSC_QUERY_TIMEOUT_MS, type OSCValue } from './osc.js'
import { UpdateVariableDefinitions, type ModuleVariableKey, type VariablesSchema } from './variables.js'
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

function truncateFloat(value: OSCValue): OSCValue {
	return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value * 1_000_000) / 1_000_000 : value
}

function safeOscValue(value: OSCValue): JsonValue {
	return value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value
}

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config!: ModuleConfig
	private commandRows: CommandRow[] = []
	private selectorProviders: SelectorProvider[] = []
	private mixer: digico | undefined
	private ipadRelay: IpadRelay | undefined
	private readonly oscValues = new Map<string, JsonValue>()
	private readonly selectorCounts = new Map<string, number>()
	private readonly feedbackPaths = new Map<string, string>()
	private readonly sentFeedbackQueries = new Set<string>()
	private readonly pendingValueReads = new Map<string, Promise<JsonValue | undefined>>()
	private readonly actionRecorder = new IncomingActionRecorder((action, uniqueId) => this.recordAction(action, uniqueId))
	private discoveryGeneration = 0
	private definitionsTimer: ReturnType<typeof setTimeout> | undefined

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = this.normalizeConfig(config)
		this.commandRows = loadCommandTable()
		this.selectorProviders = deriveSelectorProviders(this.commandRows)
		this.updateVariableDefinitions()
		this.publishCounts()
		this.setVariableValues({ filename: '' })
		this.startRuntime()
	}

	async destroy(): Promise<void> {
		await this.stopRuntime()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		await this.stopRuntime()
		this.resetConnectionState()
		this.config = this.normalizeConfig(config)
		this.commandRows = loadCommandTable()
		this.selectorProviders = deriveSelectorProviders(this.commandRows)
		this.startRuntime()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	public send_osc(path: string, args: OSCSomeArguments): void {
		this.mixer?.sendOsc(path, args)
	}

	public forwardConsoleOscPacket(packet: Buffer): void {
		this.ipadRelay?.forwardConsolePacket(packet)
	}

	public shouldSuppressIpadFilenameReply(path: string): boolean {
		return this.ipadRelay?.shouldSuppressFilenameReply(path) ?? false
	}

	public getOscValue(path: string): JsonValue | undefined {
		return this.oscValues.get(path)
	}

	public async getOscValueOrQuery(path: string, timeoutMs = OSC_QUERY_TIMEOUT_MS): Promise<JsonValue | undefined> {
		if (this.oscValues.has(path)) return this.oscValues.get(path)
		if (!this.mixer) return undefined
		const existing = this.pendingValueReads.get(path)
		if (existing) return existing
		const request = this.mixer.queryOsc(path, undefined, timeoutMs).then(() => this.oscValues.get(path))
		this.pendingValueReads.set(path, request)
		try {
			return await request
		} finally {
			if (this.pendingValueReads.get(path) === request) this.pendingValueReads.delete(path)
		}
	}

	public getParameterChoices(path: string, axis: number): Array<{ id: number | string; label: string }> {
		const segment = getPathAxisSegment(path, axis)
		const provider = selectorProviderForSegment(segment, this.selectorProviders)
		const choicesByIndex = new Set<number>()
		const matcher = pathMatcher(path)
		for (const cachedPath of this.oscValues.keys()) {
			const match = cachedPath.match(matcher)
			const index = Number(match?.[axis + 1])
			if (Number.isInteger(index)) choicesByIndex.add(index)
		}

		const names = new Map<number, string>()
		if (provider) {
			const nameMatcher = pathMatcher(provider.namePath)
			for (const [cachedPath, value] of this.oscValues) {
				const match = cachedPath.match(nameMatcher)
				const index = Number(match?.[1])
				if (Number.isInteger(index) && typeof value === 'string') {
					names.set(index, value)
					choicesByIndex.add(index)
				}
			}
			const count = this.selectorCounts.get(provider.key)
			if (count !== undefined) for (let index = 1; index <= count; index++) choicesByIndex.add(index)
		}
		if (choicesByIndex.size === 0) choicesByIndex.add(1)

		const label = getPathAxisLabel(path, axis)
		const indexes = [...choicesByIndex]
			.filter((index) => index >= 1 && (provider ? index <= (this.selectorCounts.get(provider.key) ?? provider.maxCount) : true))
			.sort((left, right) => left - right)
		return [
			{ id: 'all', label: 'All' },
			...indexes.map((index) => ({ id: index, label: `${index}: ${names.get(index) || `${label} ${index}`}` })),
		]
	}

	public watchFeedbackValue(feedbackId: string, path: string): void {
		const previousPath = this.feedbackPaths.get(feedbackId)
		if (previousPath && previousPath !== path && ![...this.feedbackPaths.values()].includes(previousPath)) {
			this.sentFeedbackQueries.delete(previousPath)
		}
		this.feedbackPaths.set(feedbackId, path)
		if (this.oscValues.has(path) || this.sentFeedbackQueries.has(path) || !this.mixer) return
		this.sentFeedbackQueries.add(path)
		void this.mixer.queryOsc(path)
	}

	public releaseFeedbackValue(feedbackId: string): void {
		const path = this.feedbackPaths.get(feedbackId)
		this.feedbackPaths.delete(feedbackId)
		if (path && ![...this.feedbackPaths.values()].includes(path)) this.sentFeedbackQueries.delete(path)
	}

	public handleStartStopRecordActions(isRecording: boolean): void {
		this.actionRecorder.setRecording(isRecording)
		logger.debug(`Action recorder ${isRecording ? 'started' : 'stopped'}`)
	}

	public onOscMessage(path: string, args: OSCValue[]): void {
		const suppressLog = this.shouldSuppressIpadFilenameReply(path)
		const incoming = args.map(truncateFloat)
		const cachedValue: JsonValue | undefined = incoming.length === 0
			? undefined
			: path.endsWith('/modes') || incoming.length > 1
				? incoming.map(safeOscValue)
				: safeOscValue(incoming[0]!)
		const previous = this.oscValues.get(path)
		if (cachedValue !== undefined) {
			this.oscValues.set(path, cachedValue)
			this.sentFeedbackQueries.delete(path)
			if (!suppressLog) logger.debug(`Cached OSC value ${path} = ${JSON.stringify(cachedValue)}`)
			if (path === '/Console/Session/Filename' && typeof cachedValue === 'string') {
				this.setVariableValues({ filename: cachedValue })
			}
			if (path.endsWith('/name') && JSON.stringify(previous) !== JSON.stringify(cachedValue)) this.scheduleDefinitionRefresh()
			const changed = JSON.stringify(previous) !== JSON.stringify(cachedValue)
			const feedbackIds = [...this.feedbackPaths]
				.filter(([, watchedPath]) => watchedPath === path)
				.map(([feedbackId]) => feedbackId)
			if (changed && feedbackIds.length) this.checkFeedbacksById(...feedbackIds)
		}
		this.actionRecorder.record(path, incoming, this.commandRows)
		const provider = this.selectorProviders.find((entry) => entry.countPath === path)
		if (provider && typeof cachedValue === 'number') this.selectorCounts.set(provider.key, Math.max(0, Math.min(provider.maxCount, Math.trunc(cachedValue))))
	}

	public updateActions(): void {
		UpdateActions(this, this.commandRows)
	}

	public updateFeedbacks(): void {
		UpdateFeedbacks(this, this.commandRows)
	}

	public updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	private startRuntime(): void {
		try {
			if (this.config.ipadEnabled && this.config.ipadReceivePort !== this.config.receivePort) {
				try {
					this.ipadRelay = new IpadRelay(this, this.config)
				} catch (error) {
					logger.error(`Unable to start iPad OSC relay: ${String(error)}`)
				}
			} else if (this.config.ipadEnabled) {
				logger.error(`iPad receive port ${this.config.ipadReceivePort} must differ from console receive port ${this.config.receivePort}`)
			}
			this.mixer = createMixer(this, this.config)
			this.updateStatus(InstanceStatus.Ok)
			const generation = ++this.discoveryGeneration
			void this.discoverSelectors(generation)
		} catch (error) {
			this.updateStatus(InstanceStatus.UnknownError, String(error))
			logger.error(`Unable to start OSC transport: ${String(error)}`)
		}
	}

	private async discoverSelectors(generation: number): Promise<void> {
		void this.getOscValueOrQuery('/Console/Session/Filename').catch((error) => logger.debug(`Unable to query session filename: ${String(error)}`))
		if (this.mixer) {
			await this.mixer.queryOsc('/Console/Channels', undefined, 500)
			await delay(50)
			const consoleName = await this.getOscValueOrQuery('/Console/Name')
			logger.info(`Startup query /Console/Name: ${consoleName === undefined ? 'no reply' : JSON.stringify(consoleName)}`)
			this.send_osc('/Console/Session/!', [])
		}
		if (generation !== this.discoveryGeneration) return
		for (const provider of this.selectorProviders) {
			const reported = this.oscValues.get(provider.countPath)
			const count = typeof reported === 'number'
				? Math.max(0, Math.min(provider.maxCount, Math.trunc(reported)))
				: await this.discoverCount(provider.namePath, provider.maxCount, generation)
			this.selectorCounts.set(provider.key, count)
			if (typeof reported === 'number') {
				const namePaths = Array.from({ length: count }, (_, index) => provider.namePath.replace('*', String(index + 1)))
				await Promise.all(namePaths.map((path) => this.getOscValueOrQuery(path)))
			}
			if (generation !== this.discoveryGeneration) return
		}
		this.publishCounts()
		this.updateActions()
		this.updateFeedbacks()
	}

	private async discoverCount(namePath: string, maximum: number, generation: number): Promise<number> {
		let count = 0
		for (let index = 1; index <= maximum && generation === this.discoveryGeneration; index++) {
			const value = await this.getOscValueOrQuery(namePath.replace('*', String(index)))
			if (value === undefined || value === null) break
			count = index
		}
		return count
	}

	private scheduleDefinitionRefresh(): void {
		if (this.definitionsTimer) clearTimeout(this.definitionsTimer)
		this.definitionsTimer = setTimeout(() => {
			this.definitionsTimer = undefined
			this.updateActions()
			this.updateFeedbacks()
		}, 100)
	}

	private publishCounts(): void {
		const values: Partial<Record<ModuleVariableKey, string>> = {}
		for (const provider of this.selectorProviders) {
			values[provider.key as ModuleVariableKey] = this.selectorCounts.has(provider.key)
				? String(this.selectorCounts.get(provider.key))
				: ''
		}
		this.setVariableValues(values)
	}

	private async stopRuntime(): Promise<void> {
		this.discoveryGeneration++
		this.pendingValueReads.clear()
		if (this.definitionsTimer) clearTimeout(this.definitionsTimer)
		this.definitionsTimer = undefined
		await this.ipadRelay?.destroy()
		this.ipadRelay = undefined
		await this.mixer?.destroy()
		this.mixer = undefined
	}

	private resetConnectionState(): void {
		this.oscValues.clear()
		this.selectorCounts.clear()
		this.feedbackPaths.clear()
		this.sentFeedbackQueries.clear()
		this.publishCounts()
		this.setVariableValues({ filename: '' })
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
}
