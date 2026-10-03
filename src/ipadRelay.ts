import type { SharedUdpSocket } from '@companion-module/base'
import { createModuleLogger } from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { ModuleConfig } from './config.js'
import { decodeOscPacket } from './osc.js'

const logger = createModuleLogger('ipad')

/** Forwards raw OSC datagrams between the console transport and the iPad app. */
export class IpadRelay {
	private readonly socket: SharedUdpSocket
	private readonly socketReady: Promise<void>
	private listening = false
	private bound = false
	private stopped = false
	private readonly pendingFilenameReplies: Array<{ requestedAt: number; replyLogged: boolean; forwarded: boolean }> = []

	constructor(instance: ModuleInstance, private readonly config: ModuleConfig) {
		this.socket = instance.createSharedUdpSocket('udp4', (packet, remote) => {
			if (this.stopped) return
			const suppressLog = this.isSessionFilenameQueryPacket(packet)
			if (suppressLog) this.pendingFilenameReplies.push({ requestedAt: Date.now(), replyLogged: false, forwarded: false })
			if (!suppressLog) this.logPacket('iPad -> module', packet)
			this.socket.send(packet, this.config.transmitPort, this.config.ip)
			if (!suppressLog) logger.debug(`Forwarded ${packet.length} byte(s) from ${remote.address}:${remote.port} to console ${this.config.ip}:${this.config.transmitPort}`)
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
		const suppressLog = this.consumeForwardedFilenameReply(packet)
		if (!suppressLog) this.logPacket('console -> iPad', packet)
		this.socket.send(packet, this.config.ipadTransmitPort, this.config.ipadIp)
		if (!suppressLog) logger.debug(`Forwarded ${packet.length} byte(s) to iPad ${this.config.ipadIp}:${this.config.ipadTransmitPort}`)
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
		this.expireFilenameReplies()
		return !this.stopped && this.listening && path === '/Console/Session/Filename' && this.pendingFilenameReplies.length > 0
	}

	public consumeFilenameReply(path: string): void {
		if (!this.shouldSuppressFilenameReply(path)) return
		const pending = this.pendingFilenameReplies[0]
		if (pending) {
			pending.replyLogged = true
			this.removeCompletedFilenameReply(pending)
		}
	}

	private logPacket(direction: string, packet: Buffer): void {
		try {
			for (const message of decodeOscPacket(packet)) {
				const values = message.args.map((value, index) => ({ type: message.typeTags[index] ?? '?', value }))
				logger.debug(`${direction} ${message.path} ${JSON.stringify(values)}`)
			}
		} catch (error) {
			logger.debug(`${direction} opaque OSC datagram (${packet.length} byte(s)): ${String(error)}`)
		}
	}

	private isSessionFilenameQueryPacket(packet: Buffer): boolean {
		try {
			const messages = decodeOscPacket(packet)
			return messages.length > 0 && messages.every((message) => message.path === '/Console/Session/Filename/?')
		} catch {
			return false
		}
	}

	private expireFilenameReplies(): void {
		const cutoff = Date.now() - 3000
		while (this.pendingFilenameReplies[0] !== undefined && this.pendingFilenameReplies[0].requestedAt < cutoff) {
			this.pendingFilenameReplies.shift()
		}
	}

	private consumeForwardedFilenameReply(packet: Buffer): boolean {
		this.expireFilenameReplies()
		try {
			const messages = decodeOscPacket(packet)
			if (!messages.length || !messages.every((message) => message.path === '/Console/Session/Filename' && message.args.length > 0)) {
				return false
			}
			const pending = this.pendingFilenameReplies[0]
			if (!pending) return false
			pending.forwarded = true
			this.removeCompletedFilenameReply(pending)
			return true
		} catch {
			return false
		}
	}

	private removeCompletedFilenameReply(reply: { requestedAt: number; replyLogged: boolean; forwarded: boolean }): void {
		if (reply.replyLogged && reply.forwarded) {
			const index = this.pendingFilenameReplies.indexOf(reply)
			if (index >= 0) this.pendingFilenameReplies.splice(index, 1)
		}
	}
}
