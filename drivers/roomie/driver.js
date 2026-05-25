'use strict';

const Homey = require('homey');
const { RoomieClient } = require('../../lib/roomie-protocol');

class RoomieDriver extends Homey.Driver {

	async onInit() {
		this.log('Roomie driver initialized');

		this.homey.flow.getActionCard('set_roomie_airflow')
			.registerRunListener(async ({ device, mode }) => device.setAirflowMode(mode));
	}

	onPair(session) {
		const state = { ip: null, deviceId: null, unitName: null, pin: null };

		session.setHandler('scan', async ({ subnets } = {}) => {
			// Default: broadcast on every local interface. If the user passed an
			// explicit subnet (e.g. '10.0.20') we also do an active scan of that /24,
			// which works across VLANs as long as Homey can route there.
			const opts = { timeoutMs: 3000 };
			if (subnets && subnets.length) opts.scanSubnets = subnets;
			try {
				const list = await RoomieClient.discoverNetwork(opts);
				return list;
			} catch (e) {
				this.error('discoverNetwork failed:', e);
				throw new Error(`Scan failed: ${e.message}`);
			}
		});

		session.setHandler('probe', async ({ ip }) => {
			const trimmed = (ip || '').trim();
			if (!ipLooksValid(trimmed)) throw new Error('Invalid IP address');
			try {
				return await RoomieClient.discover(trimmed, 4000);
			} catch (e) {
				throw new Error(`Could not reach ${trimmed}:4000 (${e.message})`);
			}
		});

		session.setHandler('select', async ({ ip, deviceId, unitName }) => {
			if (!ipLooksValid(ip)) throw new Error('Invalid IP');
			state.ip = ip;
			state.deviceId = deviceId || null;
			state.unitName = unitName || null;
			state.pin = null;
			// If the caller didn't pass a deviceId (manual IP path), probe to fill it in.
			if (!state.deviceId) {
				const info = await RoomieClient.discover(ip, 4000);
				state.deviceId = info.deviceId;
				state.unitName = info.unitName;
			}
			return true;
		});

		session.setHandler('selection', async () => ({ ip: state.ip, deviceId: state.deviceId, unitName: state.unitName }));

		session.setHandler('verify', async ({ pin }) => {
			if (!state.ip || !state.deviceId) throw new Error('Pick a fan first');
			const trimmed = (pin || '').trim();
			if (!trimmed) throw new Error('PIN is required');
			const client = new RoomieClient({ ip: state.ip, id: state.deviceId, pwd: trimmed });
			try {
				await client.verify();
			} catch (e) {
				throw new Error(`PIN rejected by fan (${e.message})`);
			}
			state.pin = trimmed;
			return true;
		});

		session.setHandler('list_devices', async () => {
			if (!state.ip || !state.deviceId || !state.pin) {
				throw new Error('Setup incomplete — go back through the wizard.');
			}
			const existingRoles = this.getDevices()
				.map((d) => d.getSetting('role'))
				.filter(Boolean);
			const role = existingRoles.includes('A') && !existingRoles.includes('B') ? 'B' : 'A';

			const niceName = state.unitName
				? `Roomie ${state.unitName.split(' ').pop()} (${state.ip})`
				: `Roomie ${state.ip}`;

			return [{
				name: niceName,
				data: { id: state.deviceId },
				settings: {
					device_id: state.deviceId,
					ip: state.ip,
					pin: state.pin,
					role,
					poll_interval_s: 20,
				},
			}];
		});
	}

}

function ipLooksValid(ip) {
	return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every((p) => Number(p) >= 0 && Number(p) <= 255);
}

module.exports = RoomieDriver;
