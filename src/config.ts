import { Regex, type SomeCompanionConfigField } from '@companion-module/base'
import { networkInterfaces } from 'node:os'

export type ModuleConfig = {
	ip: string
	transmitPort: number
	receivePort: number
	ipadEnabled: boolean
	ipadIp: string
	ipadTransmitPort: number
	ipadReceivePort: number
}

export const DEFAULT_CONFIG: ModuleConfig = {
	ip: '192.168.1.100',
	transmitPort: 7001,
	receivePort: 7000,
	ipadEnabled: false,
	ipadIp: '192.168.1.101',
	ipadTransmitPort: 7003,
	ipadReceivePort: 7002,
}

function companionIpv4Fields(): SomeCompanionConfigField[] {
	const addresses = Object.entries(networkInterfaces()).flatMap(([name, interfaces]) =>
		(interfaces ?? [])
			.filter((address) => address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.'))
			.map((address) => ({ interfaceName: name, address: address.address })),
	)
	const addressText = addresses.length
		? addresses.map(({ interfaceName, address }) => `${address} (${interfaceName})`).join('  OR  ')
		: 'No LAN IPv4 address found'
	return [
		{
			type: 'static-text',
			id: 'companion-ipv4-help',
			label: 'Mixer setup',
			value: 'Enter one of these Companion computer IPv4 addresses as the console’s DiGiCo Pad IP on the Mixer.',
			width: 12,
		},
		{
			type: 'static-text',
			id: 'companion-ipv4-addresses',
			label: 'Companion IPv4 address',
			value: addressText,
			width: 12,
		},
	]
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		...companionIpv4Fields(),
		{
			type: 'textinput',
			id: 'ip',
			label: 'Mixer IP Address',
			width: 8,
			default: DEFAULT_CONFIG.ip,
			regex: Regex.IPV4,
		},
		{
			type: 'number',
			id: 'receivePort',
			label: 'Receive Port',
			width: 4,
			min: 1,
			max: 65535,
			default: DEFAULT_CONFIG.receivePort,
		},
		{
			type: 'number',
			id: 'transmitPort',
			label: 'Transmit Port',
			width: 4,
			min: 1,
			max: 65535,
			default: DEFAULT_CONFIG.transmitPort,
		},
		{
			type: 'checkbox',
			id: 'ipadEnabled',
			label: 'Enable simultaneous iPad connection',
			width: 8,
			default: DEFAULT_CONFIG.ipadEnabled,
			disableAutoExpression: true,
		},
		{
			type: 'textinput',
			id: 'ipadIp',
			label: 'iPad IP Address',
			width: 8,
			default: DEFAULT_CONFIG.ipadIp,
			regex: Regex.IPV4,
			isVisibleExpression: '$(options:ipadEnabled)',
		},
		{
			type: 'number',
			id: 'ipadReceivePort',
			label: 'iPad Receive Port',
			width: 4,
			min: 1,
			max: 65535,
			default: DEFAULT_CONFIG.ipadReceivePort,
			isVisibleExpression: '$(options:ipadEnabled)',
		},
		{
			type: 'number',
			id: 'ipadTransmitPort',
			label: 'iPad Transmit Port',
			width: 4,
			min: 1,
			max: 65535,
			default: DEFAULT_CONFIG.ipadTransmitPort,
			isVisibleExpression: '$(options:ipadEnabled)',
		},
	]
}
