var instance_skel = require('../../instance_skel');
var actions       = require('./actions');
var OSC           = require('osc');
var test = { address: '/sd/Input_Channels/10/mute',args: [ { type: 'i', value: 0 } ] }
var debug;
var log;
let states = {};

class instance extends instance_skel {

	constructor(system,id,config) {
		super(system,id,config)

		Object.assign(this, {...actions})

		this.actions()
	}

	actions(system) {
		this.setActions(this.getActions());
	}

	config_fields() {

	return [
		{
			type:    'text',
			id:      'info',
			width:   12,
			label:   'Information',
			value:   'This controls the DiGiCo.'
		},
		{
			type:    'textinput',
			id:      'host',
			label:   'Target IP',
			width:   6,
			regex:   this.REGEX_IP
		},
		{
			type:    'textinput',
			id:      'port',
			label:   'Target port',
			width:   6,
			regex:   this.REGEX_PORT,
			default: '8001'
		},
		{
			type:    'textinput',
			id:      'receiveport',
			label:   'Receive port',
			width:   6,
			regex:   this.REGEX_PORT,
			default: '8002'
		}
	]
	}

	action(action) {
		let id = action.action;
		let cmd, arg
		let opt = action.options;

		switch (id){
			case 'fader':
				arg = [ {
					type: "f",
					value: opt.fader
				}]
				cmd = `/sd/Input_Channels/${opt.channel}/fader`;
				break;

			case 'mute':
				arg = [ {
					type: "i",
					value: parseInt(opt.mute)
				}]
				cmd = `/sd/Input_Channels/${opt.channel}/mute`;
				break;

			case 'phantom':
				arg = [ {
					type: "i",
					value: parseInt(opt.phantom)
				}]
				cmd = `/sd/Input_Channels/${opt.channel}/Channel_Input/phantom`;
				break;

			case 'solo':
				arg = [ {
					type: "i",
					value: parseInt(opt.solo)
				}]
				cmd = `/sd/Input_Channels/${opt.channel}/solo`
				break;

			case 'snapshot':
				arg = [ {
					type: "i",
					value: parseInt(opt.snapshot)
				}]
				cmd = '/sd/Snapshots/Fire_Snapshot_number'
				break;

				case 'snapshotNext':
					arg = [ {
						type: "i",
						value: 0
					}]
					cmd = '/sd/Snapshots/Fire_Next_Snapshot'
					break;

				case 'snapshotPrev':
					arg = [ {
						type: "i",
						value: 0
					}]
					cmd = '/sd/Snapshots/Fire_Prev_Snapshot'
					break;

				case 'macros':
					// arg = [ {
					// 	type: "i",
					// 	value: parseInt(opt.macro)
					// }]
					// cmd = '/sd/Macros/Buttons/press'
					this.processMessage(test)
					break;

		}

		if (arg == null) {
			arg = [];
		}

		this.sendOSC(cmd, arg)

	}

	init_feedbacks() {
			var feedbacks = {}

			feedbacks['solo_bg'] = {
				label: 'Change colors for solo state',
				description: 'If chanel solo is in use, change colors of the bank',
				options: [
					{
						type: 'colorpicker',
						label: 'Foreground color',
						id: 'fg',
						default: self.rgb(255, 255, 255)
					},
					{
						type: 'colorpicker',
						label: 'Background color',
						id: 'bg',
						default: self.rgb(0, 255, 0)
					},
					{
						type: 'dropdown',
						label: 'solo',
						id: 'solo',
						default: 1,
						choices:  [{label: "on", id: "1"},{label: "off", id: "0"}]
					}
				]
			}
			feedbacks['mute_bg'] = {
				label: 'Change colors for mute state',
				description: 'If chanel mute is active, change colors of the bank',
				options: [
					{
						type: 'colorpicker',
						label: 'Foreground color',
						id: 'fg',
						default: self.rgb(255, 255, 255)
					},
					{
						type: 'colorpicker',
						label: 'Background color',
						id: 'bg',
						default: self.rgb(0, 255, 0)
					},
					{
						type: 'dropdown',
						label: 'mute',
						id: 'mute',
						default: 1,
						choices:  [{label: "on", id: "1"},{label: "off", id: "0"}]
					}
				]
			}
			self.setFeedbackDefinitions(feedbacks)
	}

	feedback(feedback, bank) {

		if (feedback.type === 'solo_bg') {
			if (states[channelNumber].mute === parseInt(feedback.options.solo)) {
				return { color: feedback.options.fg, bgcolor: feedback.options.bg }
			}
		}
		if (feedback.type === 'mute_bg') {
			if (states[channelNumber].mute === parseInt(feedback.options.mute)) {
				return { color: feedback.options.fg, bgcolor: feedback.options.bg }
			}
		}

		return {}
	}

	destroy() {
		this.status(this.STATUS_UNKNOWN,"Disabled")
		debug("destroy", this.id)
	}

	init() {
		debug = this.debug;
		log = this.log;

		this.init_osc();

		this.init_variables()

		this.status(this.STATE_OK)

	}

	updateConfig(config) {

		this.config = config

		this.actions()

	}

	init_variables() {

		var variables = [
			{ name: 'dynamic1', label: 'dynamic variable' },
			// { name: 'dynamic2', label: 'dynamic var2' },
		]

		// this.setVariableDefinitions(variables)

	}

	connect() {
		this.status(this.STATUS_UNKNOWN, "Connecting");
	}

	init_osc() {

		if (this.connecting) {
			return;
		}

		if (this.qSocket) {
			this.qSocket.close();
		}

		if (this.config.host) {
			this.qSocket = new OSC.UDPPort({
				localAddress: "0.0.0.0",
				localPort: this.config.receiveport,
				address: this.config.host,
				port: this.config.port,
				metadata: true
			});
			this.connecting = true;

			this.qSocket.open();

			this.qSocket.on("error", (err) => {
				debug("Error", err);
				this.log('error', "Error: " + err.message);
				this.connecting = false;
				this.status(this.STATUS_ERROR, "Can't connect to DiGiCo");
				if (err.code == "ECONNREFUSED") {
					this.qSocket.removeAllListeners();
				}
			});

			this.qSocket.on("close", () => {
				this.log('error', "Connection to DiGiCo Closed");
				this.connecting = false;
				this.status(this.STATUS_WARNING, "CLOSED");
			});

			this.qSocket.on("ready", () => {
				this.connecting = false;
				this.log('info',"Connected to DiGiCo:" + this.config.host);
			});

			this.qSocket.on("message", (message) => {
				this.processMessage(message)

			});
		}
		this.qSocket.on("data", (data) => {
			// console.log("Got: ",data, "from",this.qSocket.options.address);
		});
	}

	processMessage(message) {
		console.log("Got address: ", message.address);
		console.log("Got args: ", message.args);
		// { address: '/sd/Group_Outputs/10/mute',args: [ { type: 'i', value: 1 } ] }
		// Got address:  /sd/Input_Channels/4/mute
		// Got args:  [ { type: 'i', value: 1 } ]
		let address = message.address
		let args = message.args
		let channelNumber
		if (address.match('/sd/Input_Channels/')) {
			if(address.slice(-4) == 'mute') {
				channelNumber = address.slice(19,-5)
				console.log('Channel: '+channelNumber);
			}
			states[channelNumber] = { mute : args[0].value };
			console.log(`Channel ${channelNumber} is now ${states[channelNumber].mute}`);
			// this.setVariable('currentColumn', message.args[0].value)
		} else {
			debug(message.address, message.args);
		}
	}

	sendOSC(node, arg) {

		var host,port = "";
		if (this.config.host !== undefined && this.config.host !== ""){
			host = this.config.host;
		}
		if (this.config.port !== undefined && this.config.port !== ""){
			port = this.config.port;
		}
		this.system.emit('osc_send',host, port, node, arg)
	}

}

exports = module.exports = instance;
