var instance_skel = require('../../instance_skel');
var actions       = require('./actions');
var OSC           = require('osc');

var debug;
var log;

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
			default: '8000'
		}
	]
	}

	action(action) {
		let id = action.action;
		let cmd, arg
		let opt = action.options;

		switch (id){
			case 'fader':
				arg = null;
				cmd = `/sd/Input_Channels/${opt.channel}/fader ${opt.fader}`;
				break;

			case 'mute':
				arg = null;
				cmd = `/sd/Input_Channels/${opt.channel}/mute ${opt.mute}`;
				break;

			case 'phantom':
				arg = null;
				cmd = `/sd/Input_Channels/${opt.channel}/Channel_Input/phantom ${opt.mute}`;
				break;

			case 'solo':
				arg = null;
				cmd = `/sd/Input_Channels/${opt.channel}/solo ${opt.solo}`
		}

		if (arg == null) {
			arg = [];
		}

		debug('sending', cmd, arg, "to", self.config.host)
		self.sendOSC(cmd, arg)

	}

	destroy() {
		self.status(self.STATUS_UNKNOWN,"Disabled")
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

		this.setVariableDefinitions(variables)

	}

	connect() {
		this.status(this.STATUS_UNKNOWN, "Connecting");
		this.init_osc();
	}

	init_osc() {

		if (this.connecting) {
			return;
		}

		if (this.qSocket) {
			this.qSocket.close();
		}

		if (this.config.host) {
			this.qSocket = new OSC.TCPSocketPort({
				localAddress: "0.0.0.0",
				localPort: this.config.port + this.port_offset,
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
				this.log('error', "Connection to QLab Closed");
				this.connecting = false;
				this.status(this.STATUS_WARNING, "CLOSED");
			});

			this.qSocket.on("ready", () => {
				this.connecting = false;
				this.log('info',"Connected to DiGiCo:" + this.config.host);
			});

			this.qSocket.on("message", (message) => {
				// debug("received ", message, "from", this.qSocket.options.address);
				if (message.address.match(/^\/update\//)) {
					// debug("readUpdate");
					this.readUpdate(message);
				} else if (message.address.match(/^\/reply\//)) {
					// debug("readReply");
					this.readReply(message);
				} else {
					debug(message.address, message.args);
				}
			});
		}
		this.qSocket.on("data", (data) => {
			debug ("Got",data, "from",this.qSocket.options.address);
		});
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
