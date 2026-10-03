export type OSCValue = number | string | Uint8Array | boolean | null
export const OSC_QUERY_TIMEOUT_MS = 150

export type IncomingOscMessage = { path: string; args: OSCValue[]; typeTags: string; encoding?: 'untagged-meter-float' | 'address-only' }

function readPaddedString(packet: Buffer, offset: number, field: string): { value: string; next: number } {
	if (offset < 0 || offset >= packet.length) throw new Error(`${field} is missing at byte offset ${offset}`)
	const end = packet.indexOf(0, offset)
	if (end < 0) throw new Error(`${field} at byte offset ${offset} has no NUL terminator`)
	const next = (end + 4) & ~3
	if (next > packet.length) throw new Error(`${field} at byte offset ${offset} has incomplete 4-byte padding (ends at ${next}, packet length ${packet.length})`)
	return { value: packet.toString('utf8', offset, end), next }
}

function requireArgumentBytes(packet: Buffer, offset: number, size: number, path: string, tag: string): void {
	if (offset + size > packet.length) {
		throw new Error(`OSC argument ${tag} for ${path} is truncated at byte offset ${offset}: needs ${size} byte(s), only ${Math.max(0, packet.length - offset)} remain`)
	}
}

function decodeUntaggedMeter(packet: Buffer, path: string, offset: number): IncomingOscMessage | undefined {
	if (!/meter/i.test(path)) return undefined
	const payloadLength = packet.length - offset
	if (payloadLength < 4 || payloadLength % 4 !== 0 || payloadLength > 32) return undefined
	const args: number[] = []
	for (let position = offset; position < packet.length; position += 4) {
		args.push(packet.readFloatBE(position))
	}
	return { path, args, typeTags: 'f'.repeat(args.length), encoding: 'untagged-meter-float' }
}

function decodePacket(packet: Buffer): IncomingOscMessage[] {
	if (packet.toString('ascii', 0, 8) === '#bundle\0') {
		if (packet.length < 16) throw new Error(`OSC bundle header is truncated: needs 16 bytes, packet has ${packet.length}`)
		const messages: IncomingOscMessage[] = []
		let offset = 16
		while (offset + 4 <= packet.length) {
			const size = packet.readUInt32BE(offset)
			const sizeOffset = offset
			offset += 4
			if (size === 0 || offset + size > packet.length) throw new Error(`OSC bundle element at byte offset ${sizeOffset} has invalid size ${size} (packet length ${packet.length})`)
			try {
				messages.push(...decodePacket(packet.subarray(offset, offset + size)))
			} catch (error) {
				throw new Error(`Invalid OSC bundle element at byte offset ${offset} (size ${size}): ${String(error)}`)
			}
			offset += size
		}
		if (offset !== packet.length) throw new Error(`OSC bundle has ${packet.length - offset} trailing byte(s) after its last element`)
		return messages
	}

	const path = readPaddedString(packet, 0, 'OSC address')
	if (!path.value.startsWith('/')) throw new Error(`Invalid OSC address ${JSON.stringify(path.value)} at byte offset 0: address must start with "/"`)
	if (path.next === packet.length) {
		return [{ path: path.value, args: [], typeTags: '', encoding: 'address-only' }]
	}
	let tags: { value: string; next: number }
	try {
		tags = readPaddedString(packet, path.next, `OSC type-tag string for address ${JSON.stringify(path.value)}`)
	} catch (error) {
		const untaggedMeter = decodeUntaggedMeter(packet, path.value, path.next)
		if (untaggedMeter) return [untaggedMeter]
		throw error
	}
	if (!tags.value.startsWith(',')) {
		const untaggedMeter = decodeUntaggedMeter(packet, path.value, path.next)
		if (untaggedMeter) return [untaggedMeter]
		throw new Error(`Invalid OSC type-tag string ${JSON.stringify(tags.value)} for ${path.value} at byte offset ${path.next}: it must start with ","`)
	}
	const args: IncomingOscMessage['args'] = []
	let offset = tags.next
	for (const tag of tags.value.slice(1)) {
		switch (tag) {
			case 'i':
				requireArgumentBytes(packet, offset, 4, path.value, tag)
				args.push(packet.readInt32BE(offset))
				offset += 4
				break
			case 'f':
				requireArgumentBytes(packet, offset, 4, path.value, tag)
				args.push(packet.readFloatBE(offset))
				offset += 4
				break
			case 'h':
				requireArgumentBytes(packet, offset, 8, path.value, tag)
				args.push(Number(packet.readBigInt64BE(offset)))
				offset += 8
				break
			case 'd':
				requireArgumentBytes(packet, offset, 8, path.value, tag)
				args.push(packet.readDoubleBE(offset))
				offset += 8
				break
			case 's': {
				const value = readPaddedString(packet, offset, `OSC string argument for ${path.value}`)
				args.push(value.value)
				offset = value.next
				break
			}
			case 'b': {
				requireArgumentBytes(packet, offset, 4, path.value, tag)
				const size = packet.readUInt32BE(offset)
				offset += 4
				requireArgumentBytes(packet, offset, (size + 3) & ~3, path.value, tag)
				args.push(new Uint8Array(packet.subarray(offset, offset + size)))
				offset += (size + 3) & ~3
				break
			}
			case 'T':
				args.push(true)
				break
			case 'F':
				args.push(false)
				break
			case 'N':
			case 'I':
				args.push(null)
				break
			default:
				throw new Error(`Unsupported OSC type tag ${JSON.stringify(tag)} for ${path.value} at byte offset ${offset}`)
		}
	}
	return [{ path: path.value, args, typeTags: tags.value.slice(1) }]
}

export function decodeOscPacket(packet: Buffer): IncomingOscMessage[] {
	return decodePacket(packet)
}
