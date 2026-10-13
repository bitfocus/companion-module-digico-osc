// Knob, feedback and preset layer for encoders (Ulanzi D200X, Stream Deck +), in the same
// style as the companion-tools UAD and Panasonic modules: one click = one step (size 1-10),
// fast turns count every click, plain on/off feedbacks, channel/snapshot variables, and a
// "selected channel" strip.

import { combineRgb } from '@companion-module/base'
import type ModuleInstance from './main.js'

export const STEP_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const
export const DEFAULT_STEP_SIZE = 2
/** dB per knob click. */
export const DB_STEPS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 10]
export const FADER_MIN = -150 // the console's -inf
export const FADER_MAX = 10
const FADER_FLOOR = -60 // turning up from -inf starts here

export type StripType = 'input' | 'aux' | 'group' | 'matrix' | 'cg'

export const STRIPS: Record<StripType, { root: string; label: string; short: string; name: (n: number) => string }> = {
	input: {
		root: 'Input_Channels',
		label: 'Input',
		short: 'In',
		name: (n) => `/Input_Channels/${n}/Channel_Input/name`,
	},
	aux: { root: 'Aux_Outputs', label: 'Aux', short: 'Aux', name: (n) => `/Aux_Outputs/${n}/Buss_Trim/name` },
	group: { root: 'Group_Outputs', label: 'Group', short: 'Grp', name: (n) => `/Group_Outputs/${n}/Buss_Trim/name` },
	matrix: { root: 'Matrix_Outputs', label: 'Matrix', short: 'Mtx', name: (n) => `/Matrix_Outputs/${n}/Buss_Trim/name` },
	cg: { root: 'Control_Groups', label: 'Control Group', short: 'CG', name: (n) => `/Control_Groups/${n}/name` },
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const round2 = (n: number) => Math.round(n * 100) / 100

export function stepLevel(options: Record<string, unknown>): number {
	const n = Math.round(Number(options?.size))
	return (STEP_SIZES as readonly number[]).includes(n) ? n : DEFAULT_STEP_SIZE
}

/** Next fader value after one click: snaps -inf up to -60 dB, and drops to -inf below -60. */
export function stepDb(current: unknown, deltaDb: number): number {
	let base = Number(current)
	if (!Number.isFinite(base)) base = FADER_MIN
	if (deltaDb > 0 && base < FADER_FLOOR) base = FADER_FLOOR - deltaDb
	let next = round2(base + deltaDb)
	if (deltaDb < 0 && next < FADER_FLOOR) next = FADER_MIN
	return clamp(next, FADER_MIN, FADER_MAX)
}

export function formatDb(value: unknown): string {
	const n = Number(value)
	if (value === undefined || value === null || !Number.isFinite(n)) return ''
	if (n <= FADER_MIN + 0.1) return '-inf'
	return (n > 0 ? '+' : '') + n.toFixed(1)
}

export const faderPath = (t: StripType, n: number): string => `/${STRIPS[t].root}/${n}/fader`
export const mutePath = (t: StripType, n: number): string => `/${STRIPS[t].root}/${n}/mute`
export const soloPath = (n: number): string => `/Input_Channels/${n}/solo`
export const sendPath = (input: number, aux: number): string => `/Input_Channels/${input}/Aux_Send/${aux}/send_level`

const isOn = (v: unknown) => v === true || v === 1 || v === '1' || (typeof v === 'number' && v >= 0.5)

function count(self: ModuleInstance, t: StripType): number {
	const n = Number(self.getCached(`/Console/${STRIPS[t].root}`))
	return Number.isFinite(n) && n > 0 ? Math.min(n, 256) : 0
}

function stripName(self: ModuleInstance, t: StripType, n: number): string {
	const v = self.getCached(STRIPS[t].name(n))
	return typeof v === 'string' && v.trim() ? v.trim() : `${STRIPS[t].short} ${n}`
}

// ---------- selection ----------

type Selection = { type: StripType; index: number; aux: number }
const selections = new WeakMap<ModuleInstance, Selection>()
export function selection(self: ModuleInstance): Selection {
	let s = selections.get(self)
	if (!s) {
		s = { type: 'input', index: 1, aux: 1 }
		selections.set(self, s)
	}
	return s
}

// ---------- actions ----------

const sizeOption = {
	type: 'dropdown',
	id: 'size',
	label: 'Step size',
	default: DEFAULT_STEP_SIZE,
	choices: STEP_SIZES.map((n) => ({
		id: n,
		label:
			n === 1 ? '1 (tiny, smoothest)' : n === DEFAULT_STEP_SIZE ? `${n} (default)` : n === 10 ? '10 (huge)' : String(n),
	})),
	tooltip: 'dB per click: 0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 10',
} as const

const directionOption = {
	type: 'dropdown',
	id: 'direction',
	label: 'Direction',
	default: 'up',
	choices: [
		{ id: 'up', label: 'Up (rotate right)' },
		{ id: 'down', label: 'Down (rotate left)' },
	],
} as const

const typeOption = {
	type: 'dropdown',
	id: 'strip',
	label: 'Type',
	default: 'input',
	choices: (Object.keys(STRIPS) as StripType[]).map((t) => ({ id: t, label: STRIPS[t].label })),
} as const

const numberOption = (id = 'index', label = 'Number') =>
	({ type: 'number', id, label, default: 1, min: 1, max: 256 }) as const

const modeOption = {
	type: 'dropdown',
	id: 'mode',
	label: 'Mode',
	default: 'toggle',
	choices: [
		{ id: 'toggle', label: 'Toggle' },
		{ id: 'on', label: 'On' },
		{ id: 'off', label: 'Off' },
	],
} as const

async function current(self: ModuleInstance, path: string): Promise<unknown> {
	return self.getCached(path) ?? (await self.getOscValueOrQuery(path))
}

async function stepFader(self: ModuleInstance, path: string, options: Record<string, unknown>): Promise<void> {
	const delta = DB_STEPS[stepLevel(options) - 1] * (options.direction === 'down' ? -1 : 1)
	self.send_osc(path, { type: 'f', value: stepDb(await current(self, path), delta) } as any)
}

async function setBool(self: ModuleInstance, path: string, mode: unknown): Promise<void> {
	const next = mode === 'on' ? 1 : mode === 'off' ? 0 : isOn(await current(self, path)) ? 0 : 1
	self.send_osc(path, { type: 'f', value: next } as any)
}

function moveSelection(self: ModuleInstance, delta: number): void {
	const s = selection(self)
	const max = count(self, s.type) || 256
	s.index = ((s.index - 1 + delta + max) % max) + 1
}

export function getKnobActions(self: ModuleInstance): Record<string, any> {
	const refresh = () => self.refreshKnobValues()
	return {
		knob_fader_step: {
			name: '[Knob] Fader step',
			description: 'One fixed dB step per click. Put Up on Rotate right and Down on Rotate left.',
			options: [typeOption, numberOption(), directionOption, sizeOption],
			callback: async (e: any) => stepFader(self, faderPath(e.options.strip, Number(e.options.index)), e.options),
		},
		knob_send_step: {
			name: '[Knob] Input → aux send step',
			options: [numberOption('index', 'Input'), numberOption('aux', 'Aux'), directionOption, sizeOption],
			callback: async (e: any) => stepFader(self, sendPath(Number(e.options.index), Number(e.options.aux)), e.options),
		},
		strip_mute: {
			name: '[Strip] Mute',
			description: 'For a momentary mute, use On on press and Off on release.',
			options: [typeOption, numberOption(), modeOption],
			callback: async (e: any) => setBool(self, mutePath(e.options.strip, Number(e.options.index)), e.options.mode),
		},
		strip_solo: {
			name: '[Strip] Input solo',
			options: [numberOption('index', 'Input'), modeOption],
			callback: async (e: any) => setBool(self, soloPath(Number(e.options.index)), e.options.mode),
		},
		sel_select: {
			name: '[Selected] Select channel',
			options: [typeOption, numberOption()],
			callback: async (e: any) => {
				const s = selection(self)
				s.type = e.options.strip
				s.index = Number(e.options.index) || 1
				void current(self, faderPath(s.type, s.index))
				refresh()
			},
		},
		sel_next: {
			name: '[Selected] Next / previous channel (knob)',
			options: [directionOption],
			callback: async (e: any) => {
				moveSelection(self, e.options.direction === 'down' ? -1 : 1)
				void current(self, faderPath(selection(self).type, selection(self).index))
				refresh()
			},
		},
		sel_aux: {
			name: '[Selected] Select aux (monitor mix)',
			options: [numberOption('aux', 'Aux')],
			callback: async (e: any) => {
				selection(self).aux = Number(e.options.aux) || 1
				refresh()
			},
		},
		sel_aux_next: {
			name: '[Selected] Next / previous aux (knob)',
			options: [directionOption],
			callback: async (e: any) => {
				const s = selection(self)
				const max = count(self, 'aux') || 64
				s.aux = ((s.aux - 1 + (e.options.direction === 'down' ? -1 : 1) + max) % max) + 1
				refresh()
			},
		},
		sel_fader_step: {
			name: '[Selected] Fader step (knob)',
			options: [directionOption, sizeOption],
			callback: async (e: any) => {
				const s = selection(self)
				await stepFader(self, faderPath(s.type, s.index), e.options)
			},
		},
		sel_send_step: {
			name: '[Selected] Send to selected aux step (knob)',
			description: 'Only for inputs: changes the selected input’s send to the selected aux.',
			options: [directionOption, sizeOption],
			callback: async (e: any) => {
				const s = selection(self)
				if (s.type !== 'input') return
				await stepFader(self, sendPath(s.index, s.aux), e.options)
			},
		},
		sel_mute: {
			name: '[Selected] Mute',
			options: [modeOption],
			callback: async (e: any) => {
				const s = selection(self)
				await setBool(self, mutePath(s.type, s.index), e.options.mode)
			},
		},
	}
}

// ---------- feedbacks ----------

export function getKnobFeedbacks(self: ModuleInstance): Record<string, any> {
	const red = { bgcolor: combineRgb(200, 0, 0), color: combineRgb(255, 255, 255) }
	const yellow = { bgcolor: combineRgb(230, 180, 0), color: combineRgb(0, 0, 0) }
	const blue = { bgcolor: combineRgb(0, 90, 200), color: combineRgb(255, 255, 255) }
	return {
		strip_muted: {
			type: 'boolean',
			name: '[Strip] Muted',
			defaultStyle: red,
			options: [typeOption, numberOption()],
			callback: (fb: any) => isOn(self.getCached(mutePath(fb.options.strip, Number(fb.options.index)))),
		},
		strip_soloed: {
			type: 'boolean',
			name: '[Strip] Input soloed',
			defaultStyle: yellow,
			options: [numberOption('index', 'Input')],
			callback: (fb: any) => isOn(self.getCached(soloPath(Number(fb.options.index)))),
		},
		sel_is: {
			type: 'boolean',
			name: '[Selected] This channel is selected',
			defaultStyle: blue,
			options: [typeOption, numberOption()],
			callback: (fb: any) => {
				const s = selection(self)
				return s.type === fb.options.strip && s.index === Number(fb.options.index)
			},
		},
		sel_muted: {
			type: 'boolean',
			name: '[Selected] Selected channel is muted',
			defaultStyle: red,
			options: [],
			callback: () => {
				const s = selection(self)
				return isOn(self.getCached(mutePath(s.type, s.index)))
			},
		},
		snapshot_is: {
			type: 'boolean',
			name: '[Snapshot] Current snapshot is number',
			defaultStyle: { bgcolor: combineRgb(0, 140, 0), color: combineRgb(255, 255, 255) },
			options: [numberOption('snapshot', 'Snapshot number (as on the console)')],
			callback: (fb: any) => String(currentSnapshot(self).number) === String(fb.options.snapshot),
		},
		console_online: {
			type: 'boolean',
			name: '[Console] Connected',
			defaultStyle: { bgcolor: combineRgb(0, 140, 0), color: combineRgb(255, 255, 255) },
			options: [],
			callback: () => self.isConsoleOnline,
		},
	}
}

// ---------- variables ----------

function currentSnapshot(self: ModuleInstance): { number: string; name: string; next: string; prev: string } {
	const index = Number(self.getCached('/Snapshots/Current_Snapshot'))
	const list = self.getEntityChoices('Snapshots')
	const pos = list.findIndex((c) => c.id === index)
	const label = (i: number) => (i >= 0 && i < list.length ? list[i].label : '')
	// Labels look like "12: Verse 1"; split the console number from the name when present.
	const split = (text: string) => {
		const m = /^\s*([\d.]+)\s*[:\-–]\s*(.*)$/.exec(text)
		return m ? { number: m[1], name: m[2] } : { number: '', name: text }
	}
	const cur = split(label(pos))
	return {
		number: cur.number || (Number.isFinite(index) && index >= 0 ? String(index) : ''),
		name: cur.name,
		next: split(label(pos + 1)).name,
		prev: split(label(pos - 1)).name,
	}
}

export function getKnobVariableDefinitions(self: ModuleInstance): Record<string, { name: string }> {
	const defs: Record<string, { name: string }> = {
		connected: { name: 'Console connected (yes/no)' },
		console_name: { name: 'Console name' },
		snap_current_num: { name: 'Current snapshot number' },
		snap_current_name: { name: 'Current snapshot name' },
		snap_next_name: { name: 'Next snapshot name' },
		snap_prev_name: { name: 'Previous snapshot name' },
		sel_name: { name: 'Selected channel name' },
		sel_label: { name: 'Selected channel type + number, e.g. In 12' },
		sel_level: { name: 'Selected channel fader (dB)' },
		sel_mute: { name: 'Selected channel mute (on/off)' },
		sel_aux_name: { name: 'Selected aux name' },
		sel_send_level: { name: 'Selected input → selected aux send (dB)' },
	}
	for (const t of Object.keys(STRIPS) as StripType[]) {
		for (let n = 1; n <= count(self, t); n++) {
			defs[`${t}_${n}_name`] = { name: `${STRIPS[t].label} ${n} name` }
			defs[`${t}_${n}_level`] = { name: `${STRIPS[t].label} ${n} fader (dB)` }
		}
	}
	return defs
}

export function getKnobVariableValues(self: ModuleInstance): Record<string, string> {
	const s = selection(self)
	const snap = currentSnapshot(self)
	const values: Record<string, string> = {
		connected: self.isConsoleOnline ? 'yes' : 'no',
		console_name: (() => {
			const name = self.getCached('/Console/Name')
			return typeof name === 'string' || typeof name === 'number' ? String(name) : ''
		})(),
		snap_current_num: snap.number,
		snap_current_name: snap.name,
		snap_next_name: snap.next,
		snap_prev_name: snap.prev,
		sel_name: stripName(self, s.type, s.index),
		sel_label: `${STRIPS[s.type].short} ${s.index}`,
		sel_level: formatDb(self.getCached(faderPath(s.type, s.index))),
		sel_mute: isOn(self.getCached(mutePath(s.type, s.index))) ? 'on' : 'off',
		sel_aux_name: stripName(self, 'aux', s.aux),
		sel_send_level: s.type === 'input' ? formatDb(self.getCached(sendPath(s.index, s.aux))) : '',
	}
	for (const t of Object.keys(STRIPS) as StripType[]) {
		for (let n = 1; n <= count(self, t); n++) {
			values[`${t}_${n}_name`] = stripName(self, t, n)
			values[`${t}_${n}_level`] = formatDb(self.getCached(faderPath(t, n)))
		}
	}
	return values
}

// ---------- presets ----------

export function getKnobPresets(self: ModuleInstance): { structure: any[]; presets: Record<string, any> } {
	const label = (self as any).label || 'digico'
	const v = (id: string) => `$(${label}:${id})`
	const white = combineRgb(255, 255, 255)
	const dark = combineRgb(30, 30, 30)
	const red = combineRgb(200, 0, 0)
	const presets: Record<string, any> = {}
	const button = (text: string, steps: any, feedbacks: any[] = [], size = '14') => ({
		type: 'simple',
		name: text.replace(/\\n|\$\([^)]*\)/g, ' ').trim(),
		style: { text, size, color: white, bgcolor: dark },
		steps: [{ down: [], up: [], ...steps }],
		feedbacks,
	})
	const knob = (name: string, text: string, left: any, right: any, push?: any) => ({
		...button(text, { rotate_left: [left], rotate_right: [right], down: push ? [push] : [] }),
		name,
	})

	presets.snap_prev = button('◀ SNAP\\n' + v('snap_prev_name'), {
		down: [{ actionId: '/Snapshots/Fire_Prev_Snapshot', options: {} }],
	})
	presets.snap_current = button(`SNAP ${v('snap_current_num')}\\n${v('snap_current_name')}`, {
		down: [{ actionId: '/Snapshots/Fire_Selected_Snapshot', options: {} }],
	})
	presets.snap_next = button('SNAP ▶\\n' + v('snap_next_name'), {
		down: [{ actionId: '/Snapshots/Fire_Next_Snapshot', options: {} }],
	})
	presets.snap_undo = button('UNDO\\nSNAP', { down: [{ actionId: '/Snapshots/Undo_Snapshot', options: {} }] })

	presets.sel_fader_knob = knob(
		'Knob: selected channel fader (push = mute)',
		`${v('sel_label')} ${v('sel_name')}\\n${v('sel_level')} dB`,
		{ actionId: 'sel_fader_step', options: { direction: 'down', size: DEFAULT_STEP_SIZE } },
		{ actionId: 'sel_fader_step', options: { direction: 'up', size: DEFAULT_STEP_SIZE } },
		{ actionId: 'sel_mute', options: { mode: 'toggle' } },
	)
	presets.sel_fader_knob.feedbacks = [{ feedbackId: 'sel_muted', options: {}, style: { bgcolor: red, color: white } }]
	presets.sel_send_knob = knob(
		'Knob: selected input → selected aux send',
		`→ ${v('sel_aux_name')}\\n${v('sel_send_level')} dB`,
		{ actionId: 'sel_send_step', options: { direction: 'down', size: DEFAULT_STEP_SIZE } },
		{ actionId: 'sel_send_step', options: { direction: 'up', size: DEFAULT_STEP_SIZE } },
	)
	presets.sel_pick_knob = knob(
		'Knob: choose channel (turn) / choose aux (push + turn not supported: use keys)',
		`CHANNEL\\n${v('sel_label')}\\n${v('sel_name')}`,
		{ actionId: 'sel_next', options: { direction: 'down' } },
		{ actionId: 'sel_next', options: { direction: 'up' } },
	)
	presets.sel_aux_knob = knob(
		'Knob: choose aux (monitor mix)',
		`AUX\\n${v('sel_aux_name')}`,
		{ actionId: 'sel_aux_next', options: { direction: 'down' } },
		{ actionId: 'sel_aux_next', options: { direction: 'up' } },
	)

	const channelKeys: string[] = []
	for (let n = 1; n <= Math.min(count(self, 'input') || 0, 64); n++) {
		const id = `in_${n}_mute`
		presets[id] = button(
			`${v(`input_${n}_name`)}\\nMUTE`,
			{ down: [{ actionId: 'strip_mute', options: { strip: 'input', index: n, mode: 'toggle' } }] },
			[{ feedbackId: 'strip_muted', options: { strip: 'input', index: n }, style: { bgcolor: red, color: white } }],
		)
		const sel = `in_${n}_select`
		presets[sel] = button(
			`${v(`input_${n}_name`)}`,
			{ down: [{ actionId: 'sel_select', options: { strip: 'input', index: n } }] },
			[
				{
					feedbackId: 'sel_is',
					options: { strip: 'input', index: n },
					style: { bgcolor: combineRgb(0, 90, 200), color: white },
				},
			],
		)
		channelKeys.push(id, sel)
	}
	const cgKeys: string[] = []
	for (let n = 1; n <= Math.min(count(self, 'cg') || 0, 32); n++) {
		const id = `cg_${n}_mute`
		presets[id] = button(
			`${v(`cg_${n}_name`)}\\nMUTE`,
			{ down: [{ actionId: 'strip_mute', options: { strip: 'cg', index: n, mode: 'toggle' } }] },
			[{ feedbackId: 'strip_muted', options: { strip: 'cg', index: n }, style: { bgcolor: red, color: white } }],
		)
		const kid = `cg_${n}_knob`
		presets[kid] = knob(
			`Control Group ${n} fader knob (push = mute)`,
			`${v(`cg_${n}_name`)}\\n${v(`cg_${n}_level`)} dB`,
			{ actionId: 'knob_fader_step', options: { strip: 'cg', index: n, direction: 'down', size: DEFAULT_STEP_SIZE } },
			{ actionId: 'knob_fader_step', options: { strip: 'cg', index: n, direction: 'up', size: DEFAULT_STEP_SIZE } },
			{ actionId: 'strip_mute', options: { strip: 'cg', index: n, mode: 'toggle' } },
		)
		presets[kid].feedbacks = [
			{ feedbackId: 'strip_muted', options: { strip: 'cg', index: n }, style: { bgcolor: red, color: white } },
		]
		cgKeys.push(id, kid)
	}

	const structure = [
		{
			id: 'knob_snapshots',
			name: 'Snapshots (D200X)',
			definitions: ['snap_prev', 'snap_current', 'snap_next', 'snap_undo'],
		},
		{
			id: 'knob_selected',
			name: 'Selected channel strip (knobs)',
			definitions: ['sel_fader_knob', 'sel_send_knob', 'sel_pick_knob', 'sel_aux_knob'],
		},
		{ id: 'knob_inputs', name: 'Inputs: mute + select keys', definitions: channelKeys },
		{ id: 'knob_cgs', name: 'Control Groups', definitions: cgKeys },
	].filter((section) => section.definitions.length)
	return { structure, presets }
}
