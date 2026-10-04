import type { SharedUdpSocket } from '@companion-module/base'
import { createModuleLogger } from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { ModuleConfig } from './config.js'
import { decodeOscPacket } from './osc.js'

const logger = createModuleLogger('ipad')
const SESSION_FILENAME_PATH = '/Console/Session/Filename'
const SESSION_FILENAME_QUERY_PATH = `${SESSION_FILENAME_PATH}/?`

/** Forwards raw OSC datagrams between the console transport and the iPad app. */
export class IpadRelay {
	private readonly socket: SharedUdpSocket
	private readonly socketReady: Promise<void>
	private listening = false
	private bound = false
	private stopped = false

	constructor(
		instance: ModuleInstance,
		private readonly config: ModuleConfig,
	) {
		this.socket = instance.createSharedUdpSocket('udp4', (packet, remote) => {
			if (this.stopped) return
			const hasLoggedMessages = this.logPacket('iPad -> module', packet)
			this.socket.send(packet, this.config.transmitPort, this.config.ip)
			if (hasLoggedMessages)
				logger.debug(
					`Forwarded ${packet.length} byte(s) from ${remote.address}:${remote.port} to console ${this.config.ip}:${this.config.transmitPort}`,
				)
		})
		this.socketReady = new Promise<void>((resolve) => {
			this.socket.once('listening', () => resolve())
			this.socket.once('error', () => resolve())
		})
		this.socket.on('error', (error) => {
			this.listening = false
			logger.error(`iPad OSC receive error on UDP ${this.config.ipadReceivePort}: ${error.message}`)
		})
		this.socket.on('listening', () => {
			this.listening = true
			this.bound = true
			logger.debug(`Listening for iPad OSC on UDP ${this.config.ipadReceivePort}`)
		})
		this.socket.bind(this.config.ipadReceivePort)
	}

	public forwardConsolePacket(packet: Buffer): void {
		if (this.stopped || !this.listening) return
		const hasLoggedMessages = this.logPacket('console -> iPad', packet)
		this.socket.send(packet, this.config.ipadTransmitPort, this.config.ipadIp)
		if (hasLoggedMessages)
			logger.debug(`Forwarded ${packet.length} byte(s) to iPad ${this.config.ipadIp}:${this.config.ipadTransmitPort}`)
	}

	public async destroy(): Promise<void> {
		this.stopped = true
		try {
			await this.socketReady
			if (this.bound) await new Promise<void>((resolve) => this.socket.close(resolve))
		} catch {
			// A bind failure means there is no active socket handle to close.
		}
		this.listening = false
		this.bound = false
	}

	public shouldSuppressFilenameReply(path: string): boolean {
		return !this.stopped && this.listening && path === SESSION_FILENAME_PATH
	}

	private logPacket(direction: string, packet: Buffer): boolean {
		try {
			let logged = false
			for (const message of decodeOscPacket(packet)) {
				if (message.path === SESSION_FILENAME_PATH || message.path === SESSION_FILENAME_QUERY_PATH) continue
				const values = message.args.map((value, index) => ({ type: message.typeTags[index] ?? '?', value }))
				logger.debug(`${direction} ${message.path} ${JSON.stringify(values)}`)
				logged = true
			}
			return logged
		} catch (error) {
			logger.debug(`${direction} opaque OSC datagram (${packet.length} byte(s)): ${String(error)}`)
			return true
		}
	}
}
