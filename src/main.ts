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
import { entityRoots, entityTargetCount, entityTargetSections, parseEntityRecord } from './entityRecords.js'
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
	private readonly dataStore = new Map<string, JsonValue>()
	private readonly entityRecords = new Map<string, Map<number, Record<string, number | string>>>()
	private readonly indexedRecords = new Map<string, Map<number, Record<string, number | string>>>()
	private readonly entityCounts = new Map<string, number>()
	private readonly selectorCounts = new Map<string, number>()
	private readonly feedbackPaths = new Map<string, string>()
	private readonly pendingValueReads = new Map<string, Promise<JsonValue | undefined>>()
	private readonly entityRefreshes = new Map<string, Promise<void>>()
	private readonly entityRefreshWaiters = new Map<string, Array<() => void>>()
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

	public async getOscValueOrQuery(path: string, timeoutMs = OSC_QUERY_TIMEOUT_MS, queryIndex?: number): Promise<JsonValue | undefined> {
		const cacheKey = queryIndex === undefined ? path : `${path}|${queryIndex}`
		if (this.dataStore.has(cacheKey)) return this.dataStore.get(cacheKey)
		if (!this.mixer) return undefined
		const existing = this.pendingValueReads.get(cacheKey)
		if (existing) return existing
		const request = this.mixer.queryOsc(path, queryIndex, timeoutMs).then(() => this.dataStore.get(cacheKey))
		this.pendingValueReads.set(cacheKey, request)
		try {
			return await request
		} finally {
			if (this.pendingValueReads.get(cacheKey) === request) this.pendingValueReads.delete(cacheKey)
		}
	}

	public getParameterChoices(path: string, axis: number): Array<{ id: number | string; label: string }> {
		const segment = getPathAxisSegment(path, axis)
		const provider = selectorProviderForSegment(segment, this.selectorProviders)
		const choicesByIndex = new Set<number>()
		const matcher = pathMatcher(path)
		for (const cachedPath of this.dataStore.keys()) {
			const match = cachedPath.match(matcher)
			const index = Number(match?.[axis + 1])
			if (Number.isInteger(index)) choicesByIndex.add(index)
		}

		const names = new Map<number, string>()
		if (provider) {
			const nameMatcher = pathMatcher(provider.namePath)
			for (const [cachedPath, value] of this.dataStore) {
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

	public getEntityChoices(root: string, section?: string): Array<{ id: number; label: string }> {
		const records = this.entityRecords.get(root)
		if (!records) return []
		return [...records.values()]
			.filter((record) => section === undefined || String(record.section ?? '').trim() === section.trim())
			.sort((left, right) => root === 'Presets'
				? String(left.group ?? '').localeCompare(String(right.group ?? '')) || Number(left.index) - Number(right.index)
				: Number(left.index) - Number(right.index))
			.map((record) => {
				const index = Number(record.index)
				const name = String(record.name ?? `${root.slice(0, -1)} ${index}`)
				if (root === 'Presets') {
					const group = String(record.group ?? '').trim()
					return { id: index, label: `${group ? `[${group}] ` : ''}${name}` }
				}
				const details = [
					record.num === undefined ? '' : `[${record.num}]`,
					record.section === undefined ? '' : `[${record.section}]`,
					record.group ? `${record.group}/` : '',
				].filter(Boolean).join(' ')
				const label = `${index}: ${details ? `${details} ` : ''}${name}`
				return { id: index, label }
			})
	}

	public getEntitySections(root: string): string[] {
		return [...new Set([...(this.entityRecords.get(root)?.values() ?? [])]
			.map((record) => String(record.section ?? '').trim())
			.filter(Boolean))]
			.sort((left, right) => left.localeCompare(right))
	}

	public getPresetSections(): string[] {
		const sections = new Map<string, string>()
		const addSection = (section: string): void => {
			const value = section.trim()
			const key = value.toLowerCase().replace(/[\s_-]+/g, '')
			if (value && !sections.has(key)) sections.set(key, value)
		}
		for (const record of this.entityRecords.get('Presets')?.values() ?? []) addSection(String(record.section ?? ''))
		for (const provider of this.selectorProviders) {
			const section = provider.section.replace(/_/g, ' ')
			addSection(section)
			if (provider.section.endsWith('_Outputs')) addSection(provider.section.replace(/_Outputs$/, '_Mix'))
		}
		for (const section of entityTargetSections()) addSection(section)
		return [...sections.values()].sort((a, b) => a.localeCompare(b))
	}

	public getPresetChoicesForSection(section: string): Array<{ id: number; label: string }> {
		return this.getEntityChoices('Presets', section)
	}

	public getPresetTargetChoices(section: string): Array<{ id: number; label: string }> {
		const provider = this.presetTargetProvider(section)
		const targetCount = entityTargetCount(section)
		if (targetCount !== undefined) return Array.from({ length: targetCount }, (_, index) => ({ id: index + 1, label: `${index + 1}: ${section} ${index + 1}` }))
		return provider
			? this.getParameterChoices(provider.namePath, 0).filter((choice): choice is { id: number; label: string } => typeof choice.id === 'number')
			: []
	}

	public getPresetTargetSection(section: string): string {
		return this.presetTargetProvider(section)?.section.replace(/_/g, ' ') ?? section
	}

	private presetTargetProvider(section: string): SelectorProvider | undefined {
		const key = section.trim().replace(/[\s-]+/g, '_').replace(/_Mix$/i, '_Outputs').toLowerCase()
		return this.selectorProviders.find((entry) => entry.key === key)
	}

	public getPresetGroupChoices(section: string): Array<{ id: string; label: string }> {
		const groups = new Set<string>()
		for (const record of this.entityRecords.get('Presets')?.values() ?? []) {
			if (String(record.section ?? '').trim() !== section.trim()) continue
			groups.add(String(record.group ?? ''))
		}
		return [...groups].sort((a, b) => a.localeCompare(b)).map((group) => ({ id: group, label: group || '(No Group)' }))
	}

	public getPresetGroupRenameChoices(section: string): Array<{ id: number; label: string }> {
		const groups = new Map<string, { index: number; group: string }>()
		for (const record of this.entityRecords.get('Presets')?.values() ?? []) {
			if (String(record.section ?? '').trim() !== section.trim()) continue
			const group = String(record.group ?? '')
			const previous = groups.get(group)
			const index = Number(record.index)
			if (!previous || index < previous.index) groups.set(group, { index, group })
		}
		return [...groups.values()].sort((a, b) => a.group.localeCompare(b.group)).map(({ index, group }) => ({
			id: index,
			label: group || '(No Group)',
		}))
	}

	public getEntityIndexes(root: string): number[] {
		return [...(this.entityRecords.get(root)?.keys() ?? [])]
	}

	public refreshEntityList(root: string): Promise<void> {
		const current = this.entityRefreshes.get(root)
		if (current) return current
		const refresh = this.loadEntityList(root).finally(() => {
			this.entityRefreshes.delete(root)
			for (const resolve of this.entityRefreshWaiters.get(root) ?? []) resolve()
			this.entityRefreshWaiters.delete(root)
		})
		this.entityRefreshes.set(root, refresh)
		return refresh
	}

	public waitForEntityRefresh(root: string, timeoutMs = 3000): Promise<boolean> {
		return new Promise((resolve) => {
			let finished = false
			const finish = (refreshed: boolean): void => {
				if (finished) return
				finished = true
				clearTimeout(timeout)
				resolve(refreshed)
			}
			const onRefresh = (): void => finish(true)
			const waiters = this.entityRefreshWaiters.get(root) ?? []
			waiters.push(onRefresh)
			this.entityRefreshWaiters.set(root, waiters)
			const timeout = setTimeout(() => {
				const current = this.entityRefreshWaiters.get(root)
				if (current) this.entityRefreshWaiters.set(root, current.filter((waiter) => waiter !== onRefresh))
				finish(false)
			}, timeoutMs)
		})
	}

	private async loadEntityList(root: string): Promise<void> {
		if (!this.mixer) return
		const generation = this.discoveryGeneration
		const countPath = `/${root}/count`
		this.dataStore.delete(countPath)
		await this.mixer.queryOsc(countPath, undefined, 1000)
		if (generation !== this.discoveryGeneration) return
		const countValue = this.dataStore.get(countPath)
		const total = typeof countValue === 'number' ? Math.max(0, Math.trunc(countValue)) : 0
		this.entityCounts.set(root, total)
		this.entityRecords.set(root, new Map())
		if (total > 0) {
			await this.mixer.queryOsc(`/${root}/names`, undefined, 1000)
			const deadline = Date.now() + 2000
			while (generation === this.discoveryGeneration && (this.entityRecords.get(root)?.size ?? 0) < total && Date.now() < deadline) {
				await delay(25)
			}
		}
		this.publishCounts()
		this.scheduleDefinitionRefresh()
	}

	public watchFeedbackValue(feedbackId: string, path: string): void {
		this.feedbackPaths.set(feedbackId, path)
	}

	public releaseFeedbackValue(feedbackId: string): void {
		this.feedbackPaths.delete(feedbackId)
	}

	public handleStartStopRecordActions(isRecording: boolean): void {
		this.actionRecorder.setRecording(isRecording)
		logger.debug(`Action recorder ${isRecording ? 'started' : 'stopped'}`)
	}

	public onOscMessage(path: string, args: OSCValue[], isQueryReply = false): void {
		const suppressLog = this.shouldSuppressIpadFilenameReply(path)
		const incoming = args.map(truncateFloat)
		const record = parseEntityRecord(path, incoming)
		const root = record ? record.schemaPath.split('/').filter(Boolean)[0]! : undefined
		if (record && root && record.schemaPath === `/${root}/name`) {
			let records = this.entityRecords.get(root)
			if (!records) this.entityRecords.set(root, (records = new Map()))
			records.set(record.index, record.value)
		} else if (record) {
			let records = this.indexedRecords.get(record.schemaPath)
			if (!records) this.indexedRecords.set(record.schemaPath, (records = new Map()))
			records.set(record.index, record.value)
		}
		const cachedValue: JsonValue = record?.value ?? (incoming.length === 0 || path.endsWith('/modes') || incoming.length > 1
			? incoming.map(safeOscValue)
			: safeOscValue(incoming[0]!))
		const previous = this.dataStore.get(path)
		this.dataStore.set(path, cachedValue)
		if (record) this.dataStore.set(`${record.schemaPath}|${record.index}`, record.value)
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
		if (!isQueryReply) {
			for (const root of new Set(this.commandRows
				.filter((row) => row.refreshEntity && pathMatcher(row.oscPath).test(path))
				.map((row) => row.refreshEntity))) {
				void this.refreshEntityList(root)
			}
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
			const reported = this.dataStore.get(provider.countPath)
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
		await this.discoverEntityLists(generation)
		this.publishCounts()
		this.updateActions()
		this.updateFeedbacks()
	}

	private async discoverEntityLists(generation: number): Promise<void> {
		if (!this.mixer) return
		for (const root of entityRoots()) {
			await this.refreshEntityList(root)
			if (generation !== this.discoveryGeneration) return
		}
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
		for (const root of entityRoots()) {
			const key = `${root.toLowerCase()}_count` as ModuleVariableKey
			values[key] = this.entityCounts.has(root) ? String(this.entityCounts.get(root)) : ''
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
		this.dataStore.clear()
		this.entityRecords.clear()
		this.indexedRecords.clear()
		this.entityCounts.clear()
		this.selectorCounts.clear()
		this.feedbackPaths.clear()
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
