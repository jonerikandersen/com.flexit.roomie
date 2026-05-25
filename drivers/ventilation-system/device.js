'use strict';

const Homey = require('homey');

const MODES = ['away', 'normal', 'boost', 'kitchen', 'summer'];

// Airflow strategy → per-role airflow value to push to each fan.
// 'A' is the "supply" side in cross-flow, 'B' is the "extract" side.
const STRATEGY = {
	recovery:  { A: 'heat_recovery', B: 'heat_recovery' },
	fresh:     { A: 'ventilation',   B: 'ventilation' },
	crossflow: { A: 'air_supply',    B: 'ventilation' },
	keep:      null,
};

class VentilationSystemDevice extends Homey.Device {

	async onInit() {
		this._lastModeChangeMs = 0;
		this._modeChangeTrigger = this.homey.flow.getTriggerCard('vsystem_mode_changed');

		if (!this.getCapabilityValue('vsystem_mode')) {
			await this.setCapabilityValue('vsystem_mode', 'normal').catch(() => {});
		}

		this.registerCapabilityListener('onoff',        (v) => this._setOnOff(v));
		this.registerCapabilityListener('dim',          (v) => this._setDim(v));
		this.registerCapabilityListener('vsystem_mode', (v) => this.setMode(v));

		// Aggregate from physical fans every 20s. Use a small offset so we tick
		// after the roomies' own polls have a chance to refresh.
		this._aggTimer = this.homey.setInterval(() => this._aggregate().catch(() => {}), 20000);
		this.homey.setTimeout(() => this._aggregate().catch(() => {}), 5000);

		this.log('Ventilation system device ready');
	}

	async onDeleted() {
		if (this._aggTimer) this.homey.clearInterval(this._aggTimer);
	}

	_roomies() {
		const driver = this.homey.drivers.getDriver('roomie');
		return driver.getDevices();
	}

	_byRole() {
		const all = this._roomies();
		const a = all.find((d) => d.getRole && d.getRole() === 'A') || all[0];
		const b = all.find((d) => d.getRole && d.getRole() === 'B') || all[1] || null;
		return { a, b, all };
	}

	async _setOnOff(on) {
		const { all } = this._byRole();
		await Promise.all(all.map((d) => d.writeOnOff(on).catch((e) => this.log(`onoff on ${d.getName()} failed: ${e.message}`))));
	}

	async _setDim(dim) {
		await this._pushSpeedToBoth(dim);
	}

	async _pushSpeedToBoth(dim) {
		const offset = (this.getSetting('imbalance_offset_pct') || 0) / 100;
		const { a, b } = this._byRole();
		const dimA = clampDim(dim * (1 + offset));
		const dimB = clampDim(dim * (1 - offset));
		const tasks = [];
		if (a) tasks.push(a.writeDim(dimA).catch((e) => this.log(`dim A: ${e.message}`)));
		if (b) tasks.push(b.writeDim(dimB).catch((e) => this.log(`dim B: ${e.message}`)));
		await Promise.all(tasks);
	}

	async _pushAirflowToBoth(mode) {
		const { all } = this._byRole();
		await Promise.all(all.map((d) => d.writeAirflow(mode).catch((e) => this.log(`airflow on ${d.getName()}: ${e.message}`))));
	}

	async _pushAirflowStrategy(strategyName) {
		const map = STRATEGY[strategyName];
		if (!map) return; // 'keep' or unknown → leave each fan as-is
		const swap = !!this.getSetting('swap_roles');
		const { a, b } = this._byRole();
		const aTarget = swap ? map.B : map.A;
		const bTarget = swap ? map.A : map.B;
		const tasks = [];
		if (a) tasks.push(a.writeAirflow(aTarget).catch((e) => this.log(`airflow A: ${e.message}`)));
		if (b) tasks.push(b.writeAirflow(bTarget).catch((e) => this.log(`airflow B: ${e.message}`)));
		await Promise.all(tasks);
	}

	async setMode(mode, { force = false } = {}) {
		if (!MODES.includes(mode)) throw new Error(`Unknown mode: ${mode}`);
		const now = Date.now();
		const minMs = (this.getSetting('min_mode_duration_s') || 0) * 1000;
		if (!force && (now - this._lastModeChangeMs) < minMs && this.getCapabilityValue('vsystem_mode') !== mode) {
			this.log(`Mode change to ${mode} suppressed (in min-duration window, ${Math.round((minMs - (now - this._lastModeChangeMs)) / 1000)}s left)`);
			return;
		}

		const speed = this._speedForMode(mode);
		const strategy = this.getSetting(`airflow_${mode}`) || 'keep';

		// Push airflow strategy first (so when speed kicks in, fans are already
		// in the right direction — fewer beeps if speed comes after a mode change).
		await this._pushAirflowStrategy(strategy);
		await this._pushSpeedToBoth(speed);

		this._lastModeChangeMs = now;
		await this.setCapabilityValue('vsystem_mode', mode).catch(() => {});
		await this.setCapabilityValue('dim', speed).catch(() => {});
		await this.setCapabilityValue('onoff', speed > 0).catch(() => {});

		if (this._modeChangeTrigger) {
			await this._modeChangeTrigger.trigger(this, { mode }, {}).catch((e) => this.log(`mode trigger: ${e.message}`));
		}
		this.log(`Mode set to ${mode} (dim=${speed.toFixed(2)})`);
	}

	_speedForMode(mode) {
		const key = `speed_${mode}`;
		const v = this.getSetting(key);
		if (typeof v === 'number') return Math.max(0, Math.min(1, v));
		// Fallback defaults match settings defaults in driver.compose.json
		return { away: 0.2, normal: 0.5, boost: 0.9, kitchen: 1.0, summer: 0.5 }[mode] || 0.5;
	}

	async _aggregate() {
		const roomies = this._roomies();
		if (roomies.length === 0) return;

		const humidities = roomies.map((d) => d.getLastHumidity()).filter((h) => typeof h === 'number');
		const avgHum = humidities.length ? Math.round(humidities.reduce((a, b) => a + b, 0) / humidities.length) : null;
		if (avgHum != null && this.hasCapability('measure_humidity') && this.getCapabilityValue('measure_humidity') !== avgHum) {
			await this.setCapabilityValue('measure_humidity', avgHum).catch(() => {});
		}

		const anyFilter = roomies.some((d) => d.getLastFilterAlarm() === true);
		if (this.hasCapability('alarm_filter') && this.getCapabilityValue('alarm_filter') !== anyFilter) {
			await this.setCapabilityValue('alarm_filter', anyFilter).catch(() => {});
		}

		// Auto-boost on humidity threshold (with hysteresis)
		if (this.getSetting('humidity_auto_boost') && avgHum != null) {
			const onThr  = this.getSetting('humidity_boost_on')  || 65;
			const offThr = this.getSetting('humidity_boost_off') || 55;
			const mode   = this.getCapabilityValue('vsystem_mode');
			if (mode !== 'kitchen') {
				if (avgHum >= onThr && mode !== 'boost') {
					await this.setMode('boost').catch((e) => this.log(`auto-boost on: ${e.message}`));
				} else if (avgHum <= offThr && mode === 'boost') {
					await this.setMode('normal').catch((e) => this.log(`auto-boost off: ${e.message}`));
				}
			}
		}
	}

	async onSettings({ changedKeys }) {
		const currentMode = this.getCapabilityValue('vsystem_mode');
		const touchedCurrentMode =
			changedKeys.some((k) => k === `speed_${currentMode}` || k === `airflow_${currentMode}` || k === 'swap_roles');
		if (touchedCurrentMode && currentMode) {
			// Re-apply current mode so the change takes effect immediately
			await this.setMode(currentMode, { force: true });
		}
	}

}

function clampDim(d) {
	return Math.max(0, Math.min(1, d));
}

module.exports = VentilationSystemDevice;
