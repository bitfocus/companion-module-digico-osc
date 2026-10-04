import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

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
	transmitPort: 7000,
	receivePort: 7001,
	ipadEnabled: false,
	ipadIp: '192.168.1.101',
	ipadTransmitPort: 7002,
	ipadReceivePort: 7003,
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'textinput',
			id: 'ip',
			label: 'Mixer IP Address',
			width: 8,
			default: DEFAULT_CONFIG.ip,
			regex: Regex.IP,
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
			label: 'Enable iPad connection',
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
			regex: Regex.IP,
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
