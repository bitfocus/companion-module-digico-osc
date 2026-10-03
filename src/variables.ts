import type ModuleInstance from './main.js'

export const PARAMETER_MAXIMUMS = {
	input_channels: 'Input Channels',
	aux_outputs: 'Aux Outputs',
	group_outputs: 'Group Outputs',
	talkback_outputs: 'Talkback Outputs',
	matrix_inputs: 'Matrix Inputs',
	matrix_outputs: 'Matrix Outputs',
	control_groups: 'Control Groups',
	graphic_eq: 'Graphic EQs',
	multis: 'Multis',
	aux_send: 'Aux Sends',
	group_send: 'Group Sends',
	matrix_send: 'Matrix Sends',
} as const

export const MODULE_VARIABLES = {
	...PARAMETER_MAXIMUMS,
	filename: 'Filename',
} as const

export type ParameterMaximumKey = keyof typeof PARAMETER_MAXIMUMS
export type ModuleVariableKey = keyof typeof MODULE_VARIABLES
export type VariablesSchema = Record<ModuleVariableKey, string>

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	const definitions = {} as Record<ModuleVariableKey, { name: string }>
	for (const [key, label] of Object.entries(MODULE_VARIABLES) as Array<[ModuleVariableKey, string]>) {
		definitions[key] = { name: label }
	}
	self.setVariableDefinitions(definitions)
}
