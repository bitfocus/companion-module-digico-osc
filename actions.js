exports.getActions  = function() {

	let actions = [];
	actions.length = 0;
	let CHOICES_CHANNELS =[]
	for (var i = 1; i < 145; i++) {
		CHOICES_CHANNELS.push({ label: `ch ${i}`, id: i})
	}
	const CHOICES_FADER = [
		{ label: '+10 db', id: 1},
		{ label: '+9 db', id: 0.975},
		{ label: '+8 db', id: 0.95},
		{ label: '+7 db', id: 0.925},
		{ label: '+6 db', id: 0.9},
		{ label: '+5 db', id: 0.875},
		{ label: '+4 db', id: 0.85},
		{ label: '+3 db', id: 0.825},
		{ label: '+2 db', id: 0.8},
		{ label: '+1 db', id: 0.775},
		{ label: '0 db', id: 0.75},
		{ label: '-1 db', id: 0.725},
		{ label: '-2 db', id: 0.7},
		{ label: '-3 db', id: 0.675},
		{ label: '-4 db', id: 0.65},
		{ label: '-5 db', id: 0.625},
		{ label: '-6 db', id: 0.6},
		{ label: '-7 db', id: 0.575},
		{ label: '-8 db', id: 0.55},
		{ label: '-9 db', id: 0.525},
		{ label: '-10 db', id: 0.5},
		{ label: '-12 db', id: 0.475},
		{ label: '-14 db', id: 0.45},
		{ label: '-16 db', id: 0.425},
		{ label: '-18 db', id: 0.4},
		{ label: '-20 db', id: 0.375},
		{ label: '-22 db', id: 0.35},
		{ label: '-24 db', id: 0.325},
		{ label: '-26 db', id: 0.3},
		{ label: '-28 db', id: 0.275},
		{ label: '-30 db', id: 0.25},
		{ label: '-50 db', id: 0.125},
		{ label: 'OFF', id: 0}
	]
	
	if(this.config.series == "S") {

		actions['snapshotS'] = {
			label: 'Fire snapshot S-series',
			options: [
				{
					label: 'number',
					type: 'number',
					id: 'snapshot',
					default: 1,
					min: 0,
					max: 9999
				}
			]
		}

		actions['snapshotNextS'] = {	label: 'Fire next snapshot S-series'	}
		
		actions['snapshotPrevS'] = {	label: 'Fire previous snapshot S-series'	}
	} else {

		actions['fader'] = {
			label: 'Set fader of channel',
			options: [
			{
				label: 'channel number',
				type: 'dropdown',
				id: 'channel',
				default: '1',
				choices: CHOICES_CHANNELS
			},
			{
				label: 'fader value',
				type: 'dropdown',
				id: 'fader',
				default: 0.75,
				choices: CHOICES_FADER
			}]
		}
	
		actions['mute'] = {
			label: 'Mute channel',
			options: [
			{
				label: 'channel number',
				type: 'dropdown',
				id: 'channel',
				default: 1,
				choices: CHOICES_CHANNELS
			},
			{
				label: 'mute on/off',
				type: 'dropdown',
				id: 'mute',
				default: '1',
				choices: [{label: "on", id: "1"},{label: "off", id: "0"}]
			}]
		}
	
		actions['phantom'] = {
			label: 'Phantom channel',
			options: [
			{
				label: 'channel number',
				type: 'dropdown',
				id: 'channel',
				default: 1,
				choices: CHOICES_CHANNELS
			},
			{
				label: 'Phantom on/off',
				type: 'dropdown',
				id: 'phantom',
				default: '1',
				choices: [{label: "on", id: "1"},{label: "off", id: "0"}]
			}]
		}
	
		actions['solo'] = {
			label: 'Solo channel',
			options: [
			{
				label: 'channel number',
				type: 'dropdown',
				id: 'channel',
				default: 1,
				choices: CHOICES_CHANNELS
			},
			{
				label: 'Solo on/off',
				type: 'dropdown',
				id: 'solo',
				default: '1',
				choices: [{label: "on", id: "1"},{label: "off", id: "0"}]
			}]
		}

		actions['snapshot'] = {
			label: 'Fire snapshot',
			options: [
				{
					label: 'number',
					type: 'number',
					id: 'snapshot',
					default: 1,
					min: 0,
					max: 9999
				}
			]
		}
		
		actions['snapshotNext'] = {	label: 'Fire next snapshot'	}
		
		actions['snapshotPrev'] = {	label: 'Fire previous snapshot'	}
		
		
		actions['macros'] = {
			label: 'Macro',
			options: [
				{
					label: 'number',
					type: 'number',
					id: 'macro',
					default: 1,
					min: 1,
					max: 255
				}
			]
		}
	}
	return actions
}
