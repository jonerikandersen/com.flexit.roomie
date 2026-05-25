'use strict';

// Throwaway Phase 0 test: prove we can read/write a Flexit Roomie WiFi V2
// over the Blauberg/EcoVent UDP protocol (port 4000) from Node.
//
// Reference: pyEcovent (aglehmann/pyEcovent), ecoventv2/__init__.py
//
// Usage:
//   node test.js                  # read full state from both fans
//   node test.js read <ip>        # read full state from one fan
//   node test.js discover <ip>    # just discover device ID
//   node test.js toggle <ip>      # toggle on/off (fan will BEEP)
//   node test.js airflow <ip> <ventilation|heat_recovery|air_supply>

const dgram = require('dgram');

const FANS = {
	tvstue:  '10.0.20.157',
	kjokken: '10.0.20.219',
};

const PORT = 4000;
const HEADER = Buffer.from([0xFD, 0xFD]);
const TYPE = 0x02;
const DEFAULT_ID = 'DEFAULT_DEVICEID';

// Password is per-device and lives outside the repo.
// Set ROOMIE_PWD before running; discovery (DEFAULT_DEVICEID) works without it.
const ROOMIE_PWD = process.env.ROOMIE_PWD || '';
const DEFAULT_PWD = ROOMIE_PWD; // used for non-discovery ops

const FUNC = {
	read: 0x01,
	write: 0x02,
	write_return: 0x03,
	inc: 0x04,
	dec: 0x05,
	resp: 0x06,
};

// Param map mirrors pyEcovent ecoventv2 params dict.
// [name, valueDecoder] — valueDecoder returns a friendly string given a hex string.
const ENUMS = {
	states: { 0: 'off', 1: 'on', 2: 'toggle' },
	speeds: { 0: 'standby', 1: 'low', 2: 'medium', 3: 'high', 0xff: 'manual' },
	timer_modes: { 0: 'off', 1: 'night', 2: 'party' },
	statuses: { 0: 'off', 1: 'on' },
	airflows: { 0: 'ventilation', 1: 'heat_recovery', 2: 'air_supply' },
	alarms: { 0: 'no', 1: 'alarm', 2: 'warning' },
	filters: { 0: 'ok', 1: 'replace' },
	unit_types: {
		0x0300: 'Vento Expert A50-1/A85-1/A100-1 W V.2',
		0x0400: 'Vento Expert Duo A30-1 W V.2',
		0x0500: 'Vento Expert A30 W V.2',
		0x0e00: 'Oxxify smart 50',
	},
	wifi_op: { 1: 'client', 2: 'ap' },
	wifi_enc: { 48: 'Open', 50: 'wpa-psk', 51: 'wpa2_psk', 52: 'wpa_wpa2_psk' },
	wifi_dhcp: { 0: 'STATIC', 1: 'DHCP', 2: 'Invert' },
};

const decInt = (hex) => parseInt(hex, 16);
const decEnum = (table) => (hex) => {
	const v = parseInt(hex, 16);
	return table[v] !== undefined ? `${table[v]} (${v})` : `unknown (${v})`;
};
const decAscii = (hex) => {
	let s = '';
	for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
	return s;
};
const decIpLE = (hex) => {
	// 4 bytes, big-endian to bytes, then "a.b.c.d"
	const b = Buffer.from(hex, 'hex');
	return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
};
const decManSpeedPct = (hex) => {
	const v = parseInt(hex, 16);
	return `${Math.round((v / 255) * 100)}% (${v})`;
};
const decFanRpm = (hex) => {
	// 2 bytes big-endian in stream → little-endian decoded
	const b = Buffer.from(hex.padStart(4, '0'), 'hex');
	return `${b[1] * 256 + b[0]} rpm`;
};
const decFirmware = (hex) => {
	const b = Buffer.from(hex.padStart(12, '0'), 'hex');
	const year = b[4] + b[5] * 256;
	return `${b[0]}.${b[1]} ${year}-${String(b[3]).padStart(2, '0')}-${String(b[2]).padStart(2, '0')}`;
};
const decTimer = (hex) => {
	const b = Buffer.from(hex.padStart(6, '0'), 'hex');
	return `${b[2]}h ${b[1]}m ${b[0]}s`;
};
const decFilterCountdown = (hex) => {
	if (hex.length === 8) {
		const b = Buffer.from(hex, 'hex');
		return `${b[2]}d ${b[1]}h ${b[0]}m`;
	}
	const b = Buffer.from(hex.padStart(6, '0'), 'hex');
	return `${b[2]}d ${b[1]}h ${b[0]}m`;
};
const decMachineHours = (hex) => {
	const b = Buffer.from(hex.padStart(8, '0'), 'hex');
	return `${b[2]}d ${b[1]}h ${b[0]}m`;
};
const decRtcDate = (hex) => {
	const b = Buffer.from(hex.padStart(8, '0'), 'hex');
	return `20${b[3]}-${String(b[2]).padStart(2, '0')}-${String(b[0]).padStart(2, '0')} (dow=${b[1]})`;
};

const PARAMS = {
	0x0001: ['state',                       decEnum(ENUMS.states)],
	0x0002: ['speed',                       decEnum(ENUMS.speeds)],
	0x0006: ['boost_status',                decEnum(ENUMS.statuses)],
	0x0007: ['timer_mode',                  decEnum(ENUMS.timer_modes)],
	0x000b: ['timer_counter',               decTimer],
	0x000f: ['humidity_sensor_state',       decEnum(ENUMS.states)],
	0x0014: ['relay_sensor_state',          decEnum(ENUMS.states)],
	0x0016: ['analogV_sensor_state',        decEnum(ENUMS.states)],
	0x0019: ['humidity_threshold',          decInt],
	0x0024: ['battery_voltage_mV',          (h) => { const b = Buffer.from(h.padStart(4,'0'),'hex'); return b[1]*256+b[0]; }],
	0x0025: ['humidity_pct',                decInt],
	0x002d: ['analogV',                     decInt],
	0x0032: ['relay_status',                decEnum(ENUMS.statuses)],
	0x0044: ['man_speed',                   decManSpeedPct],
	0x004a: ['fan1_rpm',                    decFanRpm],
	0x004b: ['fan2_rpm',                    decFanRpm],
	0x0064: ['filter_timer_countdown',      decFilterCountdown],
	0x0066: ['boost_time_min',              decInt],
	0x006f: ['rtc_time',                    decTimer],
	0x0070: ['rtc_date',                    decRtcDate],
	0x0072: ['weekly_schedule_state',       decEnum(ENUMS.states)],
	0x007c: ['device_search_id',            decAscii],
	0x007d: ['device_password',             decAscii],
	0x007e: ['machine_hours',               decMachineHours],
	0x0083: ['alarm_status',                decEnum(ENUMS.alarms)],
	0x0085: ['cloud_server_state',          decEnum(ENUMS.states)],
	0x0086: ['firmware',                    decFirmware],
	0x0088: ['filter_replacement_status',   decEnum(ENUMS.statuses)],
	0x0094: ['wifi_operation_mode',         decEnum(ENUMS.wifi_op)],
	0x0095: ['wifi_name',                   decAscii],
	0x0099: ['wifi_enc_type',               decEnum(ENUMS.wifi_enc)],
	0x009a: ['wifi_freq_channel',           decInt],
	0x009b: ['wifi_dhcp',                   decEnum(ENUMS.wifi_dhcp)],
	0x009c: ['wifi_assigned_ip',            decIpLE],
	0x009d: ['wifi_assigned_netmask',       decIpLE],
	0x009e: ['wifi_main_gateway',           decIpLE],
	0x00a3: ['current_wifi_ip',             decIpLE],
	0x00b7: ['airflow',                     decEnum(ENUMS.airflows)],
	0x00b8: ['analogV_threshold',           decInt],
	0x00b9: ['unit_type',                   decEnum(ENUMS.unit_types)],
	0x0302: ['night_mode_timer',            (h) => { const b = Buffer.from(h.padStart(4,'0'),'hex'); return `${b[1]}h ${b[0]}m`; }],
	0x0303: ['party_mode_timer',            (h) => { const b = Buffer.from(h.padStart(4,'0'),'hex'); return `${b[1]}h ${b[0]}m`; }],
	0x0304: ['humidity_status',             decEnum(ENUMS.statuses)],
	0x0305: ['analogV_status',              decEnum(ENUMS.statuses)],
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
	// value is a Buffer (possibly empty for read)
	const high = (paramId >> 8) & 0xff;
	const low = paramId & 0xff;
	const out = [];
	if (high !== 0) {
		out.push(0xff, high);
	}
	if (value && value.length > 1) {
		out.push(0xfe, value.length);
	}
	out.push(low);
	return Buffer.concat([Buffer.from(out), value || Buffer.alloc(0)]);
}

function chksum(body) {
	// 16-bit sum of bytes, little-endian
	let sum = 0;
	for (const b of body) sum = (sum + b) & 0xffff;
	const cs = Buffer.alloc(2);
	cs.writeUInt16LE(sum, 0);
	return cs;
}

function buildPacket(id, password, func, params /* [{id, value}] */) {
	const header = buildHeader(id, password);
	const paramBufs = params.map((p) => encodeParam(p.id, p.value));
	const body = Buffer.concat([header, Buffer.from([func]), ...paramBufs]);
	return Buffer.concat([HEADER, body, chksum(body)]);
}

// ---- response parser (mirrors pyEcovent parse_response) ----

function parseResponse(buf) {
	// header: FDFD (2), type (1), id_size (1), id, pwd_size (1), pwd, func (1)
	let p = 2; // skip FDFD
	const type = buf[p++];
	const idSize = buf[p++];
	const id = buf.slice(p, p + idSize).toString('ascii');
	p += idSize;
	const pwdSize = buf[p++];
	const pwd = buf.slice(p, p + pwdSize).toString('ascii');
	p += pwdSize;
	const func = buf[p++];
	const payload = buf.slice(p, buf.length - 2); // strip checksum
	const cs = buf.slice(buf.length - 2);

	// Walk payload mirroring pyEcovent.parse_response
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

	return { type, id, pwd, func, values, raw: buf.toString('hex'), checksum: cs.toString('hex') };
}

// ---- UDP send/receive ----

function send(ip, packet, { timeoutMs = 3000 } = {}) {
	return new Promise((resolve, reject) => {
		const sock = dgram.createSocket('udp4');
		let done = false;
		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			sock.close();
			reject(new Error(`Timeout: no UDP response from ${ip}:${PORT} within ${timeoutMs}ms`));
		}, timeoutMs);

		sock.on('message', (msg) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.close();
			resolve(msg);
		});
		sock.on('error', (err) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.close();
			reject(err);
		});

		sock.send(packet, PORT, ip, (err) => {
			if (err && !done) {
				done = true;
				clearTimeout(timer);
				sock.close();
				reject(err);
			}
		});
	});
}

// ---- high-level ops ----

async function discover(ip) {
	// Discovery always uses DEFAULT_DEVICEID + literal "1111" — that combo is the
	// well-known broadcast probe and works on factory-fresh devices regardless of
	// the PIN you later set in the Roomie app. Real ops below use ROOMIE_PWD.
	const pkt = buildPacket(DEFAULT_ID, '1111', FUNC.read, [{ id: 0x007c }]);
	const reply = await send(ip, pkt);
	const parsed = parseResponse(reply);
	const found = parsed.values.find((v) => v.paramId === 0x007c);
	return { id: parsed.id, deviceSearchValue: found ? decAscii(found.valHex) : null, parsed };
}

async function readAll(ip, deviceId) {
	const params = Object.keys(PARAMS).map((k) => ({ id: parseInt(k, 10) }));
	const pkt = buildPacket(deviceId, DEFAULT_PWD, FUNC.read, params);
	const reply = await send(ip, pkt, { timeoutMs: 5000 });
	return { parsed: parseResponse(reply), pkt };
}

async function writeParam(ip, deviceId, paramId, valueByte) {
	const value = Buffer.from([valueByte]);
	const pkt = buildPacket(deviceId, DEFAULT_PWD, FUNC.write_return, [{ id: paramId, value }]);
	const reply = await send(ip, pkt);
	return parseResponse(reply);
}

function fmtParams(parsed) {
	const out = [];
	for (const { paramId, valHex } of parsed.values) {
		const meta = PARAMS[paramId];
		const name = meta ? meta[0] : `unknown_0x${paramId.toString(16).padStart(4, '0')}`;
		const decoded = meta && meta[1] ? safeDecode(meta[1], valHex) : valHex;
		out.push(`  ${name.padEnd(28)} = ${decoded}    [0x${paramId.toString(16).padStart(4, '0')} hex:${valHex}]`);
	}
	return out.join('\n');
}

function safeDecode(fn, hex) {
	try { return fn(hex); } catch (e) { return `(decode error: ${e.message}, hex:${hex})`; }
}

// ---- CLI ----

async function cmdRead(ip) {
	console.log(`\n=== ${ip} ===`);
	console.log('discovering device ID…');
	const d = await discover(ip);
	console.log(`  device ID (echoed):     ${d.id}`);
	console.log(`  device_search payload:  ${d.deviceSearchValue}`);
	const useId = d.deviceSearchValue && d.deviceSearchValue !== '' ? d.deviceSearchValue : d.id;
	console.log(`  using ID for full read: ${useId}`);
	console.log('reading full param set…');
	const r = await readAll(ip, useId);
	console.log(`  raw response (${r.parsed.raw.length / 2} bytes): ${r.parsed.raw}`);
	console.log(fmtParams(r.parsed));
}

async function cmdDiscover(ip) {
	const d = await discover(ip);
	console.log(JSON.stringify({ ip, id: d.id, deviceSearchValue: d.deviceSearchValue }, null, 2));
}

async function cmdToggle(ip) {
	console.log(`\n=== TOGGLE ${ip} (fan will beep!) ===`);
	const d = await discover(ip);
	const useId = d.deviceSearchValue || d.id;
	console.log(`using ID: ${useId}`);

	// read current state
	const cur = await send(ip, buildPacket(useId, DEFAULT_PWD, FUNC.read, [{ id: 0x0001 }]));
	const curParsed = parseResponse(cur);
	const curState = curParsed.values.find((v) => v.paramId === 0x0001);
	const curVal = curState ? parseInt(curState.valHex, 16) : null;
	console.log(`current state: ${curVal === 1 ? 'ON' : curVal === 0 ? 'OFF' : `unknown(${curVal})`}`);

	const newVal = curVal === 1 ? 0 : 1;
	console.log(`writing state = ${newVal === 1 ? 'ON' : 'OFF'}…`);
	const w = await writeParam(ip, useId, 0x0001, newVal);
	console.log(`write reply: func=0x${w.func.toString(16)}, values=${JSON.stringify(w.values)}`);

	// verify
	await new Promise((r) => setTimeout(r, 500));
	const after = await send(ip, buildPacket(useId, DEFAULT_PWD, FUNC.read, [{ id: 0x0001 }]));
	const afterParsed = parseResponse(after);
	const afterState = afterParsed.values.find((v) => v.paramId === 0x0001);
	const afterVal = afterState ? parseInt(afterState.valHex, 16) : null;
	console.log(`new state: ${afterVal === 1 ? 'ON' : afterVal === 0 ? 'OFF' : `unknown(${afterVal})`}`);
}

async function cmdAirflow(ip, mode) {
	const map = { ventilation: 0, heat_recovery: 1, air_supply: 2 };
	if (!(mode in map)) throw new Error(`mode must be one of ${Object.keys(map).join(', ')}`);
	const d = await discover(ip);
	const useId = d.deviceSearchValue || d.id;
	console.log(`setting airflow on ${ip} (${useId}) → ${mode}`);
	const w = await writeParam(ip, useId, 0x00b7, map[mode]);
	console.log(`reply: func=0x${w.func.toString(16)}, values=${JSON.stringify(w.values)}`);
}

function requirePwd() {
	if (!ROOMIE_PWD) {
		throw new Error('ROOMIE_PWD env var not set — needed for read/write past discovery. Run with:\n  ROOMIE_PWD=xxxx node test.js …');
	}
}

(async () => {
	const [cmd, ...args] = process.argv.slice(2);
	try {
		if (!cmd) {
			requirePwd();
			for (const [name, ip] of Object.entries(FANS)) {
				console.log(`\n##### ${name} #####`);
				await cmdRead(ip);
			}
			return;
		}
		if (cmd === 'discover') return cmdDiscover(args[0]);
		if (cmd === 'read')     { requirePwd(); return cmdRead(args[0]); }
		if (cmd === 'toggle')   { requirePwd(); return cmdToggle(args[0]); }
		if (cmd === 'airflow')  { requirePwd(); return cmdAirflow(args[0], args[1]); }
		throw new Error(`unknown command: ${cmd}`);
	} catch (e) {
		console.error('ERROR:', e.message);
		process.exit(1);
	}
})();
