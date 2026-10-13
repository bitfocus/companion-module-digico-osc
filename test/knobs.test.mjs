// Run with: npx tsc6 -p tsconfig.build.json && node --test test/knobs.test.mjs
// Drives the knob layer against a fake module instance (no console needed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	stepDb,
	formatDb,
	getKnobActions,
	getKnobFeedbacks,
	getKnobVariableValues,
	getKnobVariableDefinitions,
	getKnobPresets,
	selection,
} from '../dist/knobs.js'

function fakeSelf(initial = {}) {
	const cache = new Map(
		Object.entries({
			'/Console/Input_Channels': 4,
			'/Console/Aux_Outputs': 2,
			'/Console/Control_Groups': 2,
			...initial,
		}),
	)
	const sent = []
	const self = {
		label: 'sd9',
		isConsoleOnline: true,
		sent,
		cache,
		getCached: (p) => cache.get(p),
		getOscValueOrQuery: async (p) => cache.get(p),
		// like main.ts: sending also updates the cache (optimistic write)
		send_osc: (p, arg) => {
			sent.push([p, arg.value])
			cache.set(p, arg.value)
		},
		getEntityChoices: () => [
			{ id: 0, label: '1: Preshow' },
			{ id: 1, label: '2: Verse' },
			{ id: 2, label: '3: Chorus' },
		],
		refreshKnobValues: () => {},
	}
	return self
}
const run = (actions, id, options) => actions[id].callback({ options })

test('dB step maths', () => {
	assert.equal(stepDb(-150, 0.5), -60, 'up from -inf starts at -60')
	assert.equal(stepDb(-59.5, -1), -150, 'below -60 drops to -inf')
	assert.equal(stepDb(9.8, 1), 10, 'clamped at +10')
	assert.equal(stepDb(undefined, 1), -60)
	assert.equal(formatDb(-150), '-inf')
	assert.equal(formatDb(3), '+3.0')
	assert.equal(formatDb(undefined), '')
})

test('fast fader knob: every click counts (uses the value we just sent, not a stale echo)', async () => {
	const self = fakeSelf({ '/Input_Channels/1/fader': 0 })
	const a = getKnobActions(self)
	for (let i = 0; i < 20; i++) await run(a, 'knob_fader_step', { strip: 'input', index: 1, direction: 'down', size: 2 })
	assert.equal(self.cache.get('/Input_Channels/1/fader'), -10)
	assert.equal(self.sent.length, 20)
})

test('mute toggle works repeatedly without console echoes', async () => {
	const self = fakeSelf({ '/Control_Groups/2/mute': 0 })
	const a = getKnobActions(self)
	const f = getKnobFeedbacks(self)
	await run(a, 'strip_mute', { strip: 'cg', index: 2, mode: 'toggle' })
	assert.equal(f.strip_muted.callback({ options: { strip: 'cg', index: 2 } }), true)
	await run(a, 'strip_mute', { strip: 'cg', index: 2, mode: 'toggle' })
	assert.equal(f.strip_muted.callback({ options: { strip: 'cg', index: 2 } }), false)
	await run(a, 'strip_mute', { strip: 'cg', index: 2, mode: 'on' })
	await run(a, 'strip_mute', { strip: 'cg', index: 2, mode: 'on' })
	assert.deepEqual(
		self.sent.map((s) => s[1]),
		[1, 0, 1, 1],
	)
})

test('selected strip: pick channel + aux, knobs act on that pair', async () => {
	const self = fakeSelf({
		'/Input_Channels/3/Channel_Input/name': 'Vox',
		'/Aux_Outputs/2/Buss_Trim/name': 'Drum wedge',
	})
	const a = getKnobActions(self)
	await run(a, 'sel_select', { strip: 'input', index: 2 })
	await run(a, 'sel_next', { direction: 'up' })
	assert.equal(selection(self).index, 3)
	await run(a, 'sel_next', { direction: 'up' })
	await run(a, 'sel_next', { direction: 'up' })
	assert.equal(selection(self).index, 1, 'wraps at the channel count')
	await run(a, 'sel_next', { direction: 'down' })
	assert.equal(selection(self).index, 4)
	await run(a, 'sel_select', { strip: 'input', index: 3 })
	await run(a, 'sel_aux', { aux: 2 })
	for (let i = 0; i < 3; i++) await run(a, 'sel_send_step', { direction: 'up', size: 2 })
	assert.equal(self.cache.get('/Input_Channels/3/Aux_Send/2/send_level'), -59)
	const vals = getKnobVariableValues(self)
	assert.equal(vals.sel_name, 'Vox')
	assert.equal(vals.sel_label, 'In 3')
	assert.equal(vals.sel_aux_name, 'Drum wedge')
	assert.equal(vals.sel_send_level, '-59.0')
	assert.equal(vals.input_1_name, 'In 1', 'falls back to a sensible name')
})

test('snapshot variables and feedback', () => {
	const self = fakeSelf({ '/Snapshots/Current_Snapshot': 1 })
	const vals = getKnobVariableValues(self)
	assert.equal(vals.snap_current_num, '2')
	assert.equal(vals.snap_current_name, 'Verse')
	assert.equal(vals.snap_next_name, 'Chorus')
	assert.equal(vals.snap_prev_name, 'Preshow')
	assert.equal(getKnobFeedbacks(self).snapshot_is.callback({ options: { snapshot: 2 } }), true)
})

test('variables and presets are built from the console counts', () => {
	const self = fakeSelf()
	const defs = getKnobVariableDefinitions(self)
	assert.ok(defs.input_4_name && defs.cg_2_level && !defs.input_5_name)
	const { structure, presets } = getKnobPresets(self)
	assert.ok(presets.sel_fader_knob.steps[0].rotate_right.length === 1)
	assert.ok(presets.cg_2_knob)
	for (const section of structure) for (const id of section.definitions) assert.ok(presets[id], `preset ${id} exists`)
})
