'use strict';

const Homey = require('homey');
const { RoomieClient } = require('../../lib/roomie-protocol');

class RoomieDevice extends Homey.Device {

	async onInit() {
		this._buildClient();
		this._lastFilterAlarm = this.getCapabilityValue('alarm_filter') || false;

		this.registerCapabilityListener('onoff',                (v)    => this._safeWrite('onoff',         () => this.client.setOnOff(v)));
		this.registerCapabilityListener('dim',                  (v)    => this._safeWrite('dim',           () => this.client.setDim(v)));
		this.registerCapabilityListener('roomie_speed_level',   (v)    => this._safeWrite('speed_level',   () => this.client.setSpeedLevel(v)));
		this.registerCapabilityListener('roomie_airflow_mode',  (v)    => this._safeWrite('airflow_mode',  () => this.client.setAirflow(v)));

		// Jitter the initial poll so two concurrent devices don't hit the network at the same millisecond.
		const jitter = Math.floor(Math.random() * 3000);
		this.homey.setTimeout(() => this._poll().catch(() => {}), jitter);
		this._startPolling();

		this.log(`Roomie device ready: ${this.getName()} @ ${this.getSetting('ip')}`);
	}

	_buildClient() {
		this.client = new RoomieClient({
			ip:  this.getSetting('ip'),
			id:  this.getData().id,
			pwd: this.getSetting('pin'),
			log: (...a) => this.log(...a),
		});
	}

	_startPolling() {
		this._stopPolling();
		const ms = Math.max(5, this.getSetting('poll_interval_s') || 20) * 1000;
		this._pollTimer = this.homey.setInterval(() => this._poll().catch(() => {}), ms);
	}

	_stopPolling() {
		if (this._pollTimer) {
			this.homey.clearInterval(this._pollTimer);
			this._pollTimer = null;
		}
	}

	async onSettings({ newSettings, changedKeys }) {
		if (changedKeys.includes('ip') || changedKeys.includes('pin')) {
			this._buildClient();
			try {
				await this.client.verify();
			} catch (e) {
				throw new Error(`New settings rejected by device: ${e.message}`);
			}
		}
		if (changedKeys.includes('poll_interval_s')) {
			this._startPolling();
		}
	}

	async onDeleted() {
		this._stopPolling();
	}

	async _poll() {
		try {
			const s = await this.client.readState();
			await this._applyState(s);
			if (!this.getAvailable()) await this.setAvailable();
		} catch (e) {
			this.log(`Poll failed: ${e.message}`);
			await this.setUnavailable(`Cannot reach fan: ${e.message}`);
		}
	}

	async _applyState(s) {
		await this._setIfChanged('onoff',                              s.stateOn);
		await this._setIfChanged('dim',                                clampDim(s.dim));
		if (s.speedLevel) await this._setIfChanged('roomie_speed_level',   s.speedLevel);
		if (s.airflow)    await this._setIfChanged('roomie_airflow_mode',  s.airflow);
		if (s.humidity != null) await this._setIfChanged('measure_humidity', s.humidity);
		if (s.fan1Rpm != null)  await this._setIfChanged('measure_rpm_supply',  s.fan1Rpm);
		if (s.fan2Rpm != null)  await this._setIfChanged('measure_rpm_extract', s.fan2Rpm);
		if (s.filterDaysRemaining != null) await this._setIfChanged('measure_filter_days_remaining', s.filterDaysRemaining);

		if (s.filterReplace != null) {
			await this._setIfChanged('alarm_filter', s.filterReplace);
			if (s.filterReplace && !this._lastFilterAlarm) {
				this._lastFilterAlarm = true;
				const card = this.homey.flow.getTriggerCard('filter_alarm_on');
				if (card) await card.trigger(this, {}, {}).catch((e) => this.log(`filter trigger: ${e.message}`));
			} else if (!s.filterReplace) {
				this._lastFilterAlarm = false;
			}
		}
	}

	async _setIfChanged(cap, value) {
		if (value == null) return;
		if (!this.hasCapability(cap)) return;
		const cur = this.getCapabilityValue(cap);
		if (cur === value) return;
		try {
			await this.setCapabilityValue(cap, value);
		} catch (e) {
			this.log(`setCapabilityValue(${cap}, ${value}) failed: ${e.message}`);
		}
	}

	async _safeWrite(label, fn) {
		try {
			await fn();
			// Re-poll soon to reflect the new state in the UI, but not so soon that the device hasn't applied it.
			this.homey.setTimeout(() => this._poll().catch(() => {}), 600);
		} catch (e) {
			this.log(`Write ${label} failed: ${e.message}`);
			throw e;
		}
	}

	// Public helpers used by ventilation-system orchestrator
	async writeDim(dim)              { return this.client.setDim(dim); }
	async writeOnOff(on)             { return this.client.setOnOff(on); }
	async writeAirflow(mode)         { return this.client.setAirflow(mode); }
	async writeSpeedLevel(name)      { return this.client.setSpeedLevel(name); }
	async setAirflowMode(mode)       { return this._safeWrite('airflow', () => this.client.setAirflow(mode)); }
	getRole()                        { return this.getSetting('role') || 'A'; }
	getLastHumidity()                { return this.getCapabilityValue('measure_humidity'); }
	getLastFilterAlarm()             { return this.getCapabilityValue('alarm_filter'); }

}

function clampDim(d) {
	if (d == null) return null;
	return Math.max(0, Math.min(1, d));
}

module.exports = RoomieDevice;
