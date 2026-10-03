import { InstanceStatus, createModuleLogger, type OSCSomeArguments, type SharedUdpSocket } from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { ModuleConfig } from './config.js'
import { decodeOscPacket, OSC_QUERY_TIMEOUT_MS } from './osc.js'

const logger = createModuleLogger('osc')
type QueuedOscMessage = {
	path: string
	args: OSCSomeArguments
	query?: boolean
	queryIndex?: number
	queryTimeoutMs?: number
	resolveQuery?: (received: boolean) => void
}

type PendingQuery = {
	timeout: ReturnType<typeof setTimeout>
	resolve: (received: boolean) => void
	timeoutMs: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function encodeOscQuery(path: string, index?: number): Buffer {
	const encodePaddedString = (value: string): Buffer => {
		const bytes = Buffer.from(value, 'utf8')
		const result = Buffer.alloc((bytes.length + 4) & ~3)
		bytes.copy(result)
		return result
	}
	const parts = [encodePaddedString(path), encodePaddedString(index === undefined ? ',' : ',i')]
	if (index !== undefined) {
		const value = Buffer.alloc(4)
		value.writeInt32BE(index)
		parts.push(value)
	}
	return Buffer.concat(parts)
}

/** Shared OSC transport and ordered queues used by all DiGiCo mixer variants. */
export class digico {
	private readonly sendQueue: QueuedOscMessage[] = []
	private readonly receiveQueue: Buffer[] = []
	private readonly pendingQueries = new Map<string, PendingQuery>()
	private readonly socket: SharedUdpSocket
	private readonly socketReady: Promise<void>
	private receiveSocketListening = false
	private receiveSocketFailed = false
	private querySocketFailureLogged = false
	private activeQueryPath: string | undefined
	private stopped = false
	private readonly sendWorker: Promise<void>
	private readonly receiveWorker: Promise<void>

	constructor(
		private readonly instance: ModuleInstance,
		private readonly config: ModuleConfig,
	) {
		this.socket = instance.createSharedUdpSocket('udp4', (packet) => {
			if (!this.stopped) {
				instance.forwardConsoleOscPacket(packet)
				this.receiveQueue.push(packet)
			}
		})
		this.socketReady = new Promise<void>((resolve) => {
			this.socket.once('listening', resolve)
			this.socket.once('error', () => resolve())
		})
		this.socket.on('error', (error) => {
			this.receiveSocketListening = false
			this.receiveSocketFailed = true
			instance.updateStatus(InstanceStatus.UnknownError, `OSC receive error: ${error.message}`)
			logger.error(`OSC receive error: ${error.message}`)
		})
		this.socket.on('listening', () => {
			this.receiveSocketListening = true
			this.receiveSocketFailed = false
			if (this.pendingQueries.size === 0) this.activeQueryPath = undefined
			instance.updateStatus(InstanceStatus.Ok)
			logger.debug(`Listening on UDP ${config.receivePort}`)
		})
		this.socket.bind(config.receivePort)
		this.sendWorker = this.runSendQueue()
		this.receiveWorker = this.runReceiveQueue()
	}

	public sendOsc(path: string, args: OSCSomeArguments): void {
		if (!this.stopped) this.sendQueue.push({ path, args })
	}

	public queryOsc(path: string, index?: number, timeoutMs = OSC_QUERY_TIMEOUT_MS): Promise<boolean> {
		return new Promise((resolve) => {
			if (this.stopped) {
				resolve(false)
				return
			}
			this.sendQueue.push({
				path: `${path}/?`,
				args: [],
				query: true,
				queryIndex: index,
				queryTimeoutMs: timeoutMs,
				resolveQuery: resolve,
			})
		})
	}

	public async destroy(): Promise<void> {
		this.stopped = true
		try {
			await this.socketReady
			await new Promise<void>((resolve) => this.socket.close(resolve))
		} catch {
			// Binding can fail before there is an open socket to close.
		}
		await Promise.all([this.sendWorker, this.receiveWorker])
		for (const message of this.sendQueue) message.resolveQuery?.(false)
		this.sendQueue.length = 0
		this.receiveQueue.length = 0
		for (const path of this.pendingQueries.keys()) this.finishPendingQuery(path, false, false)
	}

	private async runSendQueue(): Promise<void> {
		while (!this.stopped) {
			const queueIndex = this.activeQueryPath ? this.sendQueue.findIndex((queued) => !queued.query) : 0
			const message = queueIndex < 0 ? undefined : this.sendQueue.splice(queueIndex, 1)[0]
			if (!message) {
				await sleep(5)
				continue
			}
			if (message.query && !this.receiveSocketListening) {
				if (this.receiveSocketFailed) {
					this.activeQueryPath = undefined
					if (!this.querySocketFailureLogged) {
						this.querySocketFailureLogged = true
						logger.warn(`Skipping OSC queries because UDP ${this.config.receivePort} is not open`)
					}
					message.resolveQuery?.(false)
					continue
				}
				this.activeQueryPath = message.path.replace(/\/?\?$/, '')
				this.sendQueue.unshift(message)
				await sleep(5)
				continue
			}
			try {
				if (message.query) {
					const queryPath = message.path.replace(/\/?\?$/, '')
					logger.debug(`-> ${this.config.ip}:${this.config.transmitPort} ${queryPath}/?`)
					this.activeQueryPath = queryPath
					this.trackPendingQuery(
						queryPath,
						message.queryTimeoutMs ?? OSC_QUERY_TIMEOUT_MS,
						message.resolveQuery ?? (() => {}),
					)
					this.socket.send(encodeOscQuery(message.path, message.queryIndex), this.config.transmitPort, this.config.ip)
				} else {
					logger.debug(
						`-> ${this.config.ip}:${this.config.transmitPort} ${message.path} ${JSON.stringify(message.args)}`,
					)
					this.instance.oscSend(this.config.ip, this.config.transmitPort, message.path, message.args)
				}
			} catch (error) {
				if (message.query) this.finishPendingQuery(message.path.replace(/\/?\?$/, ''), false, false)
				logger.error(`OSC send failed: ${String(error)}`)
			}
		}
	}

	private async runReceiveQueue(): Promise<void> {
		while (!this.stopped) {
			const packet = this.receiveQueue.shift()
			if (!packet) {
				await sleep(5)
				continue
			}
			try {
				for (const message of decodeOscPacket(packet)) {
					this.clearPendingQueries(message.path, message.args.length > 0)
					const typedArgs = message.args.map((value, index) => ({ type: message.typeTags[index] ?? '?', value }))
					const encodingNote = message.encoding === 'untagged-meter-float' ? ' (DiGiCo untagged meter float)' : ''
					if (!this.instance.shouldSuppressIpadFilenameReply(message.path)) {
						logger.debug(`<- ${message.path} ${JSON.stringify(typedArgs)}${encodingNote}`)
					}
					this.instance.onOscMessage(message.path, message.args)
				}
			} catch (error) {
				const preview = packet.subarray(0, 128)
				const hex = preview.toString('hex')
				const ascii = preview.toString('latin1').replace(/[^\x20-\x7e]/g, '.')
				const truncated = packet.length > preview.length ? `… (${packet.length - preview.length} more byte(s))` : ''
				logger.warn(
					`Ignoring invalid OSC packet (${packet.length} byte(s)): ${String(error)}; hex=${hex}${truncated}; ascii="${ascii}${truncated}"`,
				)
			}
		}
	}

	private trackPendingQuery(path: string, timeoutMs: number, resolve: (received: boolean) => void): void {
		const existing = this.pendingQueries.get(path)
		if (existing) clearTimeout(existing.timeout)
		const timeout = setTimeout(() => {
			this.finishPendingQuery(path, false)
		}, timeoutMs)
		this.pendingQueries.set(path, { timeout, resolve, timeoutMs })
	}

	private clearPendingQueries(responsePath: string, hasValue: boolean): void {
		if (!hasValue) return
		for (const queryPath of this.pendingQueries.keys()) {
			if (
				responsePath === queryPath ||
				responsePath.startsWith(`${queryPath}/`) ||
				(queryPath === '/Console/Channels' && responsePath.startsWith('/Console/'))
			) {
				this.finishPendingQuery(queryPath, true)
			}
		}
	}

	private finishPendingQuery(path: string, received: boolean, logTimeout = true): void {
		const pending = this.pendingQueries.get(path)
		if (!pending) return
		clearTimeout(pending.timeout)
		this.pendingQueries.delete(path)
		if (this.activeQueryPath === path) this.activeQueryPath = undefined
		if (!received && logTimeout) logger.debug(`Query timed out after ${pending.timeoutMs} ms: ${path}`)
		pending.resolve(received)
	}
}

export function createMixer(instance: ModuleInstance, config: ModuleConfig): digico {
	return new digico(instance, config)
}
