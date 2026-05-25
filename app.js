'use strict';

const Homey = require('homey');

class FlexitRoomieApp extends Homey.App {

	async onInit() {
		this.log(`${this.homey.manifest.id} v${this.homey.manifest.version} starting`);
	}

}

module.exports = FlexitRoomieApp;
