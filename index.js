var instance_skel = require('../../instance_skel');
var actions       = require('./actions');
var OSC           = require('osc');

var debug;
var log;
let states = Array(257).fill(0);

class instance extends instance_skel {

	constructor(system,id,config) {
		super(system,id,config)

		Object.assign(this, {...actions})

		this.actions();
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
			value:   'This controls the DiGiCo console using the dealer provided OSC command set, the built in Ipad command set or S-Series commands.'
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
		},
		{
			type:    'dropdown',
			id:      'series',
			label:   'Command Set',
			choices: [{id: "OSC", label: "OSC"}, {id: "IPAD", label: "IPAD"}, {id: "S", label: "S-Range"}],
			default: 'IPAD'
		}
	]
	}

	action(action) {
		let id = action.action;
		let cmd, arg
		let opt = action.options;

		if(this.config.series == "IPAD") {
			switch (id){
				case 'fader':
					arg = [ {
						type: "f",
						value: opt.fader
					}]
					cmd = `/Input_Channels/${opt.channel}/fader`;
					break;

				case 'mute':
					arg = [ {
						type: "i",
						value: parseInt(opt.mute)
					}]
					cmd = `/Input_Channels/${opt.channel}/mute`;
					break;

				case 'phantom':
					arg = [ {
						type: "f",
						value: parseInt(opt.phantom)
					}]
					cmd = `/Input_Channels/${opt.channel}/Channel_Input/phantom`;
					break;

				case 'solo':
					arg = [ {
						type: "f",
						value: parseInt(opt.solo)
					}]
					cmd = `/Input_Channels/${opt.channel}/solo`
					break;

				case 'snapshot':
					arg = [ {
						type: "i",
						value: parseInt(opt.snapshot)
					}]
					cmd = '/Snapshots/Fire_Snapshot_number'
					break;

				case 'snapshotNext':
					arg = [ {
						type: "i",
						value: 0
					}]
					cmd = '/Snapshots/Fire_Next_Snapshot'
					break;

				case 'snapshotPrev':
					arg = [ {
						type: "i",
						value: 0
					}]
					cmd = '/Snapshots/Fire_Prev_Snapshot'
					break;

				case 'macros':
					arg = [ {
						type: "i",
						value: parseInt(opt.macro)-1,
					}]
					cmd = '/Macros/Buttons/press'
					break;
			}
		} else if (this.config.series == "OSC") {
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
					arg = [ {
						type: "i",
						value: parseInt(opt.macro)-1,
					}]
					cmd = '/sd/Macros/Buttons/press'
					break;
			}
		} else if (this.config.series == "S") {
			switch(id) {
				case 'snapshotS':
					arg = [ {
						type: "i",
						value: parseInt(opt.snapshot)
					}]
					cmd = `/digico/snapshots/fire`;
					break;
				case 'snapshotNextS':
					arg = [ {
						type: "i",
						value: 0
					}]
					cmd = '/digico/snapshots/fire/next'
					break;

				case 'snapshotPrevS':
					arg = [ {
						type: "i",
						value: 0
					}]
					cmd = '/digico/snapshots/fire/previous'
					break;
			}
		} else {
			cmd = '';
		}

		if (arg == null) {
			arg = [];
		}

		this.sendOSC(cmd, arg)

	}

	destroy() {
		this.status(this.STATUS_UNKNOWN,"Disabled")
		debug("destroy", this.id)
	}

	init() {
		debug = this.debug;
		log = this.log;

		this.init_osc();
		this.init_feedbacks();


		// this.init_variables()

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

	init_feedbacks() {
		const feedbacks = {};
		let self = this;


		feedbacks.macroStatus = {
			label: 'Change button color for macro state',
			description: 'Change button color of the bank per macro state',
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
					label: 'State',
					id: 'state',
					default: 1,
					choices:  [{label: "on", id: "1"},{label: "off", id: "0"}]
				},
				{
					type: 'number',
					label: 'Macro Number',
					id: 'macro',
					default: 1,
					min: 1,
					max: 256,
				}
			],
			callback: ({ options }, bank) => {
				let channel = options.macro;
				 if (options.state == states[channel].status) {
					return { color: options.fg, bgcolor: options.bg }
							}
			}
		}
		self.setFeedbackDefinitions(feedbacks);
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
				this.processMessage(message);
			  this.checkFeedbacks();
			});

			this.qSocket.on("data", (data) => {
			});
		}
	}

	processMessage(message) {
		console.log("Got address: ", message.address);
		console.log("Got args: ", message.args);
		let address = message.address
		let args    = message.args
		if (address.match('/Macros/Buttons/state')) {
		let chanNumber = args[0].value +1;
		states[chanNumber] = { status : args[1].value};
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
