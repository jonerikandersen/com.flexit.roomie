'use strict';

// Blauberg/EcoVent UDP protocol client for Flexit Roomie WiFi V2.
//
// Packet layout: FDFD <type=02> <id_size> <id ASCII> <pwd_size> <pwd ASCII>
//                <func> <params...> <chksum LE16>
//
// Verified against firmware 0.9 2024-07-08 on two Vento Expert Duo A30-1 W V.2
// units (Roomie Dual rebrand) in Phase 0.

const dgram = require('dgram');
const os = require('os');

const PORT = 4000;
const HEADER = Buffer.from([0xFD, 0xFD]);
const TYPE = 0x02;
const DEFAULT_ID = 'DEFAULT_DEVICEID';
const DISCOVERY_PWD = '1111';

const FUNC = {
	read: 0x01,
	write: 0x02,
	write_return: 0x03,
	inc: 0x04,
	dec: 0x05,
	resp: 0x06,
	// 0x07 is returned by the device on auth failure (wrong PIN/ID).
};

const PARAM = {
	state:                       0x0001,
	speed:                       0x0002,
	boost_status:                0x0006,
	timer_mode:                  0x0007,
	timer_counter:               0x000b,
	humidity_sensor_state:       0x000f,
	relay_sensor_state:          0x0014,
	analogV_sensor_state:        0x0016,
	humidity_threshold:          0x0019,
	battery_voltage:             0x0024,
	humidity:                    0x0025,
	analogV:                     0x002d,
	relay_status:                0x0032,
	man_speed:                   0x0044,
	fan1_rpm:                    0x004a,
	fan2_rpm:                    0x004b,
	filter_timer_countdown:      0x0064,
	filter_timer_reset:          0x0065,
	boost_time:                  0x0066,
	rtc_time:                    0x006f,
	rtc_date:                    0x0070,
	weekly_schedule_state:       0x0072,
	device_search:               0x007c,
	device_password:             0x007d,
	machine_hours:               0x007e,
	reset_alarms:                0x0080,
	alarm_status:                0x0083,
	cloud_server_state:          0x0085,
	firmware:                    0x0086,
	filter_replacement_status:   0x0088,
	wifi_operation_mode:         0x0094,
	wifi_name:                   0x0095,
	current_wifi_ip:             0x00a3,
	airflow:                     0x00b7,
	analogV_threshold:           0x00b8,
	unit_type:                   0x00b9,
	night_mode_timer:            0x0302,
	party_mode_timer:            0x0303,
	humidity_status:             0x0304,
	analogV_status:              0x0305,
};

const SPEED_LEVEL = { 0: 'standby', 1: 'low', 2: 'medium', 3: 'high', 0xff: 'manual' };
const SPEED_LEVEL_BY_NAME = Object.fromEntries(Object.entries(SPEED_LEVEL).map(([k, v]) => [v, Number(k)]));
const AIRFLOW = { 0: 'ventilation', 1: 'heat_recovery', 2: 'air_supply' };
const AIRFLOW_BY_NAME = Object.fromEntries(Object.entries(AIRFLOW).map(([k, v]) => [v, Number(k)]));
const STATE = { 0: 'off', 1: 'on', 2: 'toggle' };
const UNIT_TYPE = {
	0x0300: 'Vento Expert A50-1/A85-1/A100-1 W V.2',
	0x0400: 'Vento Expert Duo A30-1 W V.2',
	0x0500: 'Vento Expert A30 W V.2',
	0x0e00: 'Oxxify smart 50',
};

// ---- packet construction ----

function buildHeader(id, password) {
	const idBuf = Buffer.from(id, 'ascii');
	const pwdBuf = Buffer.from(password, 'ascii');
	return Buffer.concat([
		Buffer.from([TYPE]),
		Buffer.from([idBuf.length]),
		idBuf,
		Buffer.from([pwdBuf.length]),
		pwdBuf,
	]);
}

function encodeParam(paramId, value) {
	const high = (paramId >> 8) & 0xff;
	const low = paramId & 0xff;
	const out = [];
	if (high !== 0) out.push(0xff, high);
	if (value && value.length > 1) out.push(0xfe, value.length);
	out.push(low);
	return Buffer.concat([Buffer.from(out), value || Buffer.alloc(0)]);
}

function chksum(body) {
	let sum = 0;
	for (const b of body) sum = (sum + b) & 0xffff;
	const cs = Buffer.alloc(2);
	cs.writeUInt16LE(sum, 0);
	return cs;
}

function buildPacket(id, password, func, params) {
	const header = buildHeader(id, password);
	const paramBufs = params.map((p) => encodeParam(p.id, p.value));
	const body = Buffer.concat([header, Buffer.from([func]), ...paramBufs]);
	return Buffer.concat([HEADER, body, chksum(body)]);
}

// ---- response parser ----

function parseResponse(buf) {
	if (buf.length < 8 || buf[0] !== 0xFD || buf[1] !== 0xFD) {
		throw new Error(`Invalid response header: ${buf.toString('hex').slice(0, 12)}`);
	}
	let p = 2;
	const type = buf[p++];
	const idSize = buf[p++];
	const id = buf.slice(p, p + idSize).toString('ascii');
	p += idSize;
	const pwdSize = buf[p++];
	const pwd = buf.slice(p, p + pwdSize).toString('ascii');
	p += pwdSize;
	const func = buf[p++];
	const payload = buf.slice(p, buf.length - 2);

	const values = [];
	let response = [];
	let extFunc = 0;
	let valueCounter = 1;
	let highByte = 0;
	let isParam = true;

	for (let i = 0; i < payload.length; i++) {
		const b = payload[i];
		if (isParam && b === 0xff) { extFunc = 0xff; continue; }
		if (isParam && b === 0xfe) { extFunc = 0xfe; continue; }
		if (isParam && b === 0xfd) { extFunc = 0xfd; continue; }

		if (extFunc === 0xff) {
			highByte = b;
			extFunc = 1;
		} else if (extFunc === 0xfe) {
			valueCounter = b;
			extFunc = 2;
		} else if (extFunc === 0xfd) {
			// noop
		} else {
			if (isParam) {
				response.push(highByte);
				isParam = false;
			} else {
				valueCounter -= 1;
			}
			response.push(b);
		}

		if (valueCounter <= 0) {
			const paramId = (response[0] << 8) | response[1];
			const valHex = Buffer.from(response.slice(2)).toString('hex');
			values.push({ paramId, valHex });
			response = [];
			isParam = true;
			valueCounter = 1;
			highByte = 0;
			extFunc = 0;
		}
	}

	return { type, id, pwd, func, values };
}

// ---- UDP ----

function send(ip, packet, timeoutMs = 4000) {
	return new Promise((resolve, reject) => {
		const sock = dgram.createSocket('udp4');
		let done = false;
		const finish = (err, msg) => {
			if (done) return;
			done = true;
			clearTimeout(t);
			try { sock.close(); } catch (_) { /* ignore */ }
			if (err) reject(err); else resolve(msg);
		};
		const t = setTimeout(() => finish(new Error(`UDP timeout from ${ip}:${PORT} after ${timeoutMs}ms`)), timeoutMs);
		sock.on('message', (msg) => finish(null, msg));
		sock.on('error', (e) => finish(e));
		sock.send(packet, PORT, ip, (err) => { if (err) finish(err); });
	});
}

// ---- value decoders (hex string -> JS value) ----

function decByte(hex)         { return parseInt(hex, 16); }
function decLE16(hex)         { const b = Buffer.from(hex.padStart(4, '0'), 'hex'); return b[0] | (b[1] << 8); }
function decBE16(hex)         { return parseInt(hex, 16); }
function decLE32(hex)         { const b = Buffer.from(hex.padStart(8, '0'), 'hex'); return b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24); }
function decAscii(hex)        { return Buffer.from(hex, 'hex').toString('ascii'); }
function decFilterDays(hex) {
	// "d h m" packed. Either 3 bytes (DD HH MM little) or 4 bytes (Oxxify variant)
	const b = Buffer.from(hex, 'hex');
	if (b.length >= 3) return b[0] * 1 + b[1] / 24 + b[2] / 1440;
	return null;
}
function decFilterDaysWhole(hex) {
	const b = Buffer.from(hex, 'hex');
	if (b.length === 4) return b[2]; // Oxxify-style; days at index 2
	if (b.length === 3) return b[2]; // standard
	if (b.length === 2) return b[1];
	return Math.floor(decFilterDays(hex) || 0);
}

// ---- high-level client ----

class RoomieClient {

	constructor({ ip, id, pwd, log = () => {} }) {
		if (!ip) throw new Error('ip required');
		this.ip = ip;
		this.id = id || DEFAULT_ID;
		this.pwd = pwd || '';
		this.log = log;
	}

	// Discovery: ask the device for its real ID. Works without the real PIN.
	static async discover(ip, timeoutMs = 4000) {
		const pkt = buildPacket(DEFAULT_ID, DISCOVERY_PWD, FUNC.read, [{ id: PARAM.device_search }]);
		const reply = await send(ip, pkt, timeoutMs);
		const parsed = parseResponse(reply);
		const idVal = parsed.values.find((v) => v.paramId === PARAM.device_search);
		const unitVal = parsed.values.find((v) => v.paramId === PARAM.unit_type);
		return {
			ip,
			deviceId: idVal ? decAscii(idVal.valHex) : parsed.id,
			unitType: unitVal ? decBE16(unitVal.valHex) : null,
			unitName: unitVal ? (UNIT_TYPE[decBE16(unitVal.valHex)] || `unknown 0x${unitVal.valHex}`) : null,
		};
	}

	// Network-wide discovery.
	// - broadcasts: list of broadcast addresses (default = derived from local
	//   interfaces + 255.255.255.255). Fast, but doesn't cross VLAN.
	// - scanSubnets: list of "a.b.c" prefixes — scan x.1..x.254 in parallel.
	//   Slower (still ~3s) but works across routed VLANs.
	static discoverNetwork({ timeoutMs = 3000, broadcasts = null, scanSubnets = [] } = {}) {
		const pkt = buildPacket(DEFAULT_ID, DISCOVERY_PWD, FUNC.read, [{ id: PARAM.device_search }]);
		const found = new Map();

		const bcasts = (broadcasts && broadcasts.length) ? broadcasts : defaultBroadcasts();

		const targets = new Set();
		for (const b of bcasts) targets.add(b);
		for (const prefix of scanSubnets) {
			for (let i = 1; i <= 254; i++) targets.add(`${prefix}.${i}`);
		}

		return new Promise((resolve, reject) => {
			const sock = dgram.createSocket('udp4');
			let settled = false;
			const finish = (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try { sock.close(); } catch (_) { /* ignore */ }
				if (err) reject(err); else resolve(Array.from(found.values()));
			};
			const timer = setTimeout(() => finish(), timeoutMs);
			sock.on('error', (e) => finish(e));
			sock.on('message', (msg, rinfo) => {
				try {
					const parsed = parseResponse(msg);
					const idVal = parsed.values.find((v) => v.paramId === PARAM.device_search);
					const unitVal = parsed.values.find((v) => v.paramId === PARAM.unit_type);
					if (idVal) {
						found.set(rinfo.address, {
							ip: rinfo.address,
							deviceId: decAscii(idVal.valHex),
							unitType: unitVal ? decBE16(unitVal.valHex) : null,
							unitName: unitVal ? (UNIT_TYPE[decBE16(unitVal.valHex)] || `unknown 0x${unitVal.valHex}`) : null,
						});
					}
				} catch (_) { /* drop malformed */ }
			});
			sock.bind(() => {
				try { sock.setBroadcast(true); } catch (_) { /* ignore */ }
				for (const addr of targets) {
					sock.send(pkt, PORT, addr, () => { /* swallow per-target errors so one bad host doesn't kill the scan */ });
				}
			});
		});
	}

	async _read(paramIds) {
		const params = paramIds.map((id) => ({ id }));
		const pkt = buildPacket(this.id, this.pwd, FUNC.read, params);
		const reply = await send(this.ip, pkt);
		const parsed = parseResponse(reply);
		if (parsed.func === 0x07) {
			throw new Error(`Device rejected read (func=0x07). Likely wrong PIN or device ID.`);
		}
		const map = {};
		for (const { paramId, valHex } of parsed.values) map[paramId] = valHex;
		return map;
	}

	async _writeOne(paramId, valueByte) {
		const value = Buffer.from(Array.isArray(valueByte) ? valueByte : [valueByte]);
		const pkt = buildPacket(this.id, this.pwd, FUNC.write_return, [{ id: paramId, value }]);
		const reply = await send(this.ip, pkt);
		const parsed = parseResponse(reply);
		if (parsed.func === 0x07) {
			throw new Error(`Device rejected write of 0x${paramId.toString(16)} (func=0x07). Likely wrong PIN.`);
		}
		return parsed;
	}

	// Verify we can talk to the device with the configured PIN.
	async verify() {
		const map = await this._read([PARAM.state]);
		if (!(PARAM.state in map)) throw new Error('Device responded but did not return state');
		return true;
	}

	// Snapshot used for capability polling. One UDP round-trip, ~16 params.
	async readState() {
		const ids = [
			PARAM.state,
			PARAM.speed,
			PARAM.boost_status,
			PARAM.humidity_sensor_state,
			PARAM.humidity,
			PARAM.man_speed,
			PARAM.fan1_rpm,
			PARAM.fan2_rpm,
			PARAM.filter_timer_countdown,
			PARAM.alarm_status,
			PARAM.filter_replacement_status,
			PARAM.airflow,
			PARAM.unit_type,
		];
		const map = await this._read(ids);
		const get = (id) => map[id];

		const speedRaw = get(PARAM.speed);
		const airflowRaw = get(PARAM.airflow);
		const manSpeed = get(PARAM.man_speed) ? decByte(get(PARAM.man_speed)) : null;
		const speedLevel = speedRaw != null ? SPEED_LEVEL[decByte(speedRaw)] : null;
		const stateOn = get(PARAM.state) != null ? decByte(get(PARAM.state)) === 1 : null;

		return {
			stateOn,
			speedLevel,
			speedRaw: speedRaw != null ? decByte(speedRaw) : null,
			manSpeed,
			// Homey 'dim' (0..1). When in named speed mode (low/med/high) we
			// reflect that as the equivalent percentage so the slider looks sane;
			// in manual mode we use the actual man_speed value.
			dim: dimFromSpeed(speedLevel, manSpeed),
			humidity:  get(PARAM.humidity)  != null ? decByte(get(PARAM.humidity))  : null,
			boost:     get(PARAM.boost_status) != null ? decByte(get(PARAM.boost_status)) === 1 : null,
			fan1Rpm:   get(PARAM.fan1_rpm)   != null ? decLE16(get(PARAM.fan1_rpm))   : null,
			fan2Rpm:   get(PARAM.fan2_rpm)   != null ? decLE16(get(PARAM.fan2_rpm))   : null,
			filterReplace: get(PARAM.filter_replacement_status) != null ? decByte(get(PARAM.filter_replacement_status)) === 1 : null,
			filterDaysRemaining: get(PARAM.filter_timer_countdown) ? decFilterDaysWhole(get(PARAM.filter_timer_countdown)) : null,
			alarm: get(PARAM.alarm_status) != null ? decByte(get(PARAM.alarm_status)) : null,
			airflow: airflowRaw != null ? AIRFLOW[decByte(airflowRaw)] : null,
			unitType: get(PARAM.unit_type) != null ? (UNIT_TYPE[decBE16(get(PARAM.unit_type))] || null) : null,
			raw: map,
		};
	}

	// ---- writes ----

	setOnOff(on)          { return this._writeOne(PARAM.state, on ? 1 : 0); }

	setSpeedLevel(name) {
		const v = SPEED_LEVEL_BY_NAME[name];
		if (v == null) throw new Error(`unknown speed level: ${name}`);
		return this._writeOne(PARAM.speed, v);
	}

	// dim is 0..1. Maps to man_speed 0..255 and forces speed=manual.
	async setDim(dim) {
		const clamped = Math.max(0, Math.min(1, dim));
		const v = Math.round(clamped * 255);
		await this._writeOne(PARAM.man_speed, v);
		await this._writeOne(PARAM.speed, 0xff); // manual
	}

	setAirflow(name) {
		const v = AIRFLOW_BY_NAME[name];
		if (v == null) throw new Error(`unknown airflow: ${name}`);
		return this._writeOne(PARAM.airflow, v);
	}

	setHumiditySensor(on) { return this._writeOne(PARAM.humidity_sensor_state, on ? 1 : 0); }
	setHumidityThreshold(pct) { return this._writeOne(PARAM.humidity_threshold, Math.max(0, Math.min(100, Math.round(pct)))); }
	setCloudServer(on)    { return this._writeOne(PARAM.cloud_server_state, on ? 1 : 0); }
	resetFilterTimer()    { return this._writeOne(PARAM.filter_timer_reset, 0); }
	resetAlarms()         { return this._writeOne(PARAM.reset_alarms, 0); }
}

function defaultBroadcasts() {
	const out = new Set(['255.255.255.255']);
	try {
		const ifs = os.networkInterfaces();
		for (const list of Object.values(ifs)) {
			for (const ifc of list || []) {
				if (ifc.family !== 'IPv4' || ifc.internal) continue;
				if (ifc.address && ifc.netmask) {
					const bcast = ipBroadcast(ifc.address, ifc.netmask);
					if (bcast) out.add(bcast);
				}
			}
		}
	} catch (_) { /* ignore — fall back to global broadcast */ }
	return Array.from(out);
}

function ipBroadcast(ip, mask) {
	const ipParts = ip.split('.').map(Number);
	const maskParts = mask.split('.').map(Number);
	if (ipParts.length !== 4 || maskParts.length !== 4) return null;
	return ipParts.map((p, i) => (p | (~maskParts[i] & 0xff))).join('.');
}

function dimFromSpeed(speedLevel, manSpeed) {
	if (speedLevel === 'manual' && manSpeed != null) return manSpeed / 255;
	if (speedLevel === 'standby') return 0;
	if (speedLevel === 'low')     return 0.33;
	if (speedLevel === 'medium')  return 0.66;
	if (speedLevel === 'high')    return 1.0;
	return null;
}

module.exports = {
	RoomieClient,
	PARAM,
	FUNC,
	SPEED_LEVEL,
	AIRFLOW,
	UNIT_TYPE,
	// exposed for tests
	_internal: { buildPacket, parseResponse, chksum, encodeParam },
};
