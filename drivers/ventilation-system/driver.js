'use strict';

const Homey = require('homey');

class VentilationSystemDriver extends Homey.Driver {

	async onInit() {
		this.log('Ventilation system driver initialized');

		this.homey.flow.getActionCard('set_vsystem_mode')
			.registerRunListener(async ({ device, mode }) => device.setMode(mode));

		this.homey.flow.getConditionCard('vsystem_is_mode')
			.registerRunListener(async ({ device, mode }) => device.getCapabilityValue('vsystem_mode') === mode);
	}

	onPair(session) {
		session.setHandler('preflight', async () => {
			const roomieDriver = this.homey.drivers.getDriver('roomie');
			const roomies = roomieDriver.getDevices();
			return {
				roomieCount: roomies.length,
				systemExists: this.getDevices().length >= 1,
			};
		});

		session.setHandler('list_devices', async () => {
			const roomieDriver = this.homey.drivers.getDriver('roomie');
			const roomies = roomieDriver.getDevices();
			if (roomies.length < 2) {
				throw new Error(`Add both Roomie fans first — currently ${roomies.length} paired. The system device coordinates an existing pair.`);
			}
			if (this.getDevices().length >= 1) {
				throw new Error('A balanced system device already exists — only one is supported per app.');
			}
			return [{
				name: 'Balanced Ventilation System',
				data: { id: `vsystem-${Date.now()}` },
			}];
		});
	}

}

module.exports = VentilationSystemDriver;
