const API_URL = "https://xhc.xhsmartpiano.com/device/firmware/check";
const FIRMWARE_PROXY_URL = "/api/firmware/proxy";
const CURRENT_VERSION = "1.3.2";
const APP_ID = "com.hsinghai.hsinghaipiano";
const APP_BUILD = "202605221619";
const APP_VERSION = "2.2.2";
const TUPTUP_MIDI_MODEL = "TUPTUP TS01-MIDI";

const CMD = {
  VERSION_QUERY: 0x00,
  INIT: 0x01,
  DATA_BASE: 0x02,
  FINISH: 0x10,
};
const RESP = { ACK: 0x06, CRC_ERROR: 0x13 };
const ETX = 0xF7;
const LINES_PER_CMD = 128;
const MAX_RETRY = 3;

const els = {
  connectBtn: document.getElementById("connectBtn"),
  checkBtn: document.getElementById("checkBtn"),
  upgradeBtn: document.getElementById("upgradeBtn"),
  pickFileBtn: document.getElementById("pickFileBtn"),
  firmwareFileInput: document.getElementById("firmwareFileInput"),
  connStatus: document.getElementById("connStatus"),
  deviceName: document.getElementById("deviceName"),
  currentVersion: document.getElementById("currentVersion"),
  latestVersion: document.getElementById("latestVersion"),
  fileSize: document.getElementById("fileSize"),
  releaseNote: document.getElementById("releaseNote"),
  stage: document.getElementById("stage"),
  percent: document.getElementById("percent"),
  bar: document.getElementById("bar"),
  log: document.getElementById("log"),
};

const state = {
  midiAccess: null,
  input: null,
  output: null,
  transportType: "none",
  sendPacket: null,
  usbDevice: null,
  usbOutEndpoint: null,
  usbInEndpoint: null,
  usbReadLoopRunning: false,
  usbRxBuffer: [],
  responseWaiter: null,
  firmwareInfo: null,
  rawDisplayName: "",
  currentVersion: CURRENT_VERSION,
  localFirmwareLines: null,
  localFirmwareName: "",
};

function getMidiDisplayName(port) {
  if (!port) return "";
  // Web MIDI没有直接暴露kMIDIPropertyDisplayName，优先用name近似映射
  return (port.name || "").trim();
}

function isTupTupName(name) {
  return /^tuptup/i.test((name || "").trim());
}

function isSoundWalkerName(name) {
  return /soundwalker/i.test((name || "").trim());
}

function selectTargetPorts(inputs, outputs) {
  const inputInfos = inputs.map((port) => ({ port, name: getMidiDisplayName(port) }));
  const outputInfos = outputs.map((port) => ({ port, name: getMidiDisplayName(port) }));

  // 1) 优先选 TupTup* 的同名输入输出对
  for (const out of outputInfos) {
    if (!isTupTupName(out.name)) continue;
    const matchedInput = inputInfos.find((i) => i.name === out.name && isTupTupName(i.name));
    if (matchedInput) {
      return {
        input: matchedInput.port,
        output: out.port,
        displayName: out.name,
        reason: "matched_tuptup_pair",
      };
    }
  }

  // 2) 次优：任意 TupTup* 输出，输入用同名或第一个
  const tupOut = outputInfos.find((o) => isTupTupName(o.name));
  if (tupOut) {
    const matchedInput = inputInfos.find((i) => i.name === tupOut.name) || inputInfos[0];
    return {
      input: matchedInput.port,
      output: tupOut.port,
      displayName: tupOut.name,
      reason: "tuptup_output_fallback_input",
    };
  }

  // 3) Web侧常见业务端口：SoundWalker MIDI，优先于SAM5704芯片端口
  for (const out of outputInfos) {
    if (!isSoundWalkerName(out.name)) continue;
    const matchedInput =
      inputInfos.find((i) => i.name === out.name) ||
      inputInfos.find((i) => isSoundWalkerName(i.name)) ||
      inputInfos[0];
    return {
      input: matchedInput.port,
      output: out.port,
      displayName: out.name,
      reason: "soundwalker_pair_fallback",
    };
  }

  // 4) 兜底：沿用同名优先，再退化到第一个
  for (const out of outputInfos) {
    const matchedInput = inputInfos.find((i) => i.name === out.name);
    if (matchedInput) {
      return {
        input: matchedInput.port,
        output: out.port,
        displayName: out.name || matchedInput.name,
        reason: "matched_name_pair_fallback",
      };
    }
  }

  return {
    input: inputInfos[0].port,
    output: outputInfos[0].port,
    displayName: outputInfos[0].name || inputInfos[0].name || "未知设备",
    reason: "first_port_fallback",
  };
}

function resolveDisplayModel(selectedDisplayName) {
  if (isSoundWalkerName(selectedDisplayName)) {
    return TUPTUP_MIDI_MODEL;
  }
  return selectedDisplayName;
}

function logPortList(inputs, outputs) {
  for (let i = 0; i < inputs.length; i++) {
    const p = inputs[i];
    log(`Input[${i}] name=${p.name || ""} manufacturer=${p.manufacturer || ""} id=${p.id || ""}`);
  }
  for (let i = 0; i < outputs.length; i++) {
    const p = outputs[i];
    log(`Output[${i}] name=${p.name || ""} manufacturer=${p.manufacturer || ""} id=${p.id || ""}`);
  }
}

function log(msg) {
  const now = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  els.log.textContent += `[${now}] ${msg}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function setStage(text, percent) {
  els.stage.textContent = text;
  if (typeof percent === "number") {
    const p = Math.max(0, Math.min(100, percent));
    els.percent.textContent = `${p}%`;
    els.bar.style.width = `${p}%`;
  }
}

function setConnected(connected, name = "-") {
  els.connStatus.textContent = connected ? "已连接" : "未连接";
  els.deviceName.textContent = name;
  els.checkBtn.disabled = !connected;
  els.pickFileBtn.disabled = !connected;
}

function ensureWebMidi() {
  if (!navigator.requestMIDIAccess) {
    throw new Error("当前浏览器不支持 Web MIDI，请使用 Chrome/Edge。");
  }
}

function onMidiMessage(event) {
  const data = Array.from(event.data || []);
  handleIncomingSysex(data);
}

function handleIncomingSysex(data) {
  if (data.length < 2) return;
  if (data[0] !== 0xF0 || data[data.length - 1] !== 0xF7) return;
  if (state.responseWaiter && state.responseWaiter.match(data)) {
    state.responseWaiter.resolve(new Uint8Array(data));
    state.responseWaiter = null;
  }
}

function encodeUsbMidiSysex(messageBytes) {
  const packets = [];
  let i = 0;
  while (i < messageBytes.length) {
    const remain = messageBytes.length - i;
    if (remain > 3) {
      packets.push(0x04, messageBytes[i], messageBytes[i + 1], messageBytes[i + 2]);
      i += 3;
      continue;
    }
    if (remain === 1) {
      packets.push(0x05, messageBytes[i], 0x00, 0x00);
      i += 1;
      continue;
    }
    if (remain === 2) {
      packets.push(0x06, messageBytes[i], messageBytes[i + 1], 0x00);
      i += 2;
      continue;
    }
    packets.push(0x07, messageBytes[i], messageBytes[i + 1], messageBytes[i + 2]);
    i += 3;
  }
  return new Uint8Array(packets);
}

function decodeUsbMidiSysexBytes(rawData) {
  const bytes = [];
  for (let i = 0; i + 3 < rawData.length; i += 4) {
    const cin = rawData[i] & 0x0f;
    const b1 = rawData[i + 1];
    const b2 = rawData[i + 2];
    const b3 = rawData[i + 3];
    if (cin === 0x4) bytes.push(b1, b2, b3);
    else if (cin === 0x5) bytes.push(b1);
    else if (cin === 0x6) bytes.push(b1, b2);
    else if (cin === 0x7) bytes.push(b1, b2, b3);
  }

  return bytes;
}

function feedUsbSysexBytes(bytes) {
  const messages = [];
  for (const b of bytes) {
    if (b === 0xF0) {
      state.usbRxBuffer = [0xF0];
      continue;
    }
    if (!state.usbRxBuffer.length) continue;
    state.usbRxBuffer.push(b);
    if (b === 0xF7) {
      messages.push(state.usbRxBuffer.slice());
      state.usbRxBuffer = [];
    }
  }
  return messages;
}

async function startUsbReadLoop() {
  if (!state.usbDevice || state.usbInEndpoint == null || state.usbReadLoopRunning) return;
  state.usbReadLoopRunning = true;
  while (state.usbReadLoopRunning && state.usbDevice.opened) {
    try {
      const result = await state.usbDevice.transferIn(state.usbInEndpoint, 512);
      if (!result || result.status !== "ok" || !result.data) continue;
      const raw = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
      const sysexBytes = decodeUsbMidiSysexBytes(raw);
      const msgs = feedUsbSysexBytes(sysexBytes);
      for (const msg of msgs) handleIncomingSysex(msg);
    } catch (e) {
      log(`USB读失败: ${e.message}`);
      state.usbReadLoopRunning = false;
      break;
    }
  }
}

async function connectWebUsbMidi() {
  if (!navigator.usb) throw new Error("当前浏览器不支持 WebUSB");
  const device = await navigator.usb.requestDevice({ filters: [{ classCode: 0x01, subclassCode: 0x03 }] });
  await device.open();
  if (!device.configuration) await device.selectConfiguration(1);

  let found = null;
  for (const iface of device.configuration.interfaces) {
    for (const alt of iface.alternates) {
      if (alt.interfaceClass !== 0x01 || alt.interfaceSubclass !== 0x03) continue;
      const outEp = alt.endpoints.find((e) => e.direction === "out");
      const inEp = alt.endpoints.find((e) => e.direction === "in");
      if (outEp && inEp) {
        found = { iface, outEp, inEp };
        break;
      }
    }
    if (found) break;
  }
  if (!found) throw new Error("未找到可用的USB MIDI端点");

  await device.claimInterface(found.iface.interfaceNumber);
  state.usbDevice = device;
  state.usbOutEndpoint = found.outEp.endpointNumber;
  state.usbInEndpoint = found.inEp.endpointNumber;
  state.transportType = "webusb";
  state.sendPacket = async (command) => {
    const usbData = encodeUsbMidiSysex(command);
    const out = await device.transferOut(state.usbOutEndpoint, usbData);
    if (!out || out.status !== "ok") throw new Error(`USB发送失败: ${out?.status || "unknown"}`);
  };

  startUsbReadLoop();
  return device;
}

async function connectMidi() {
  ensureWebMidi();
  const midiAccess = await navigator.requestMIDIAccess({ sysex: true });
  const inputs = Array.from(midiAccess.inputs.values());
  const outputs = Array.from(midiAccess.outputs.values());
  if (!inputs.length || !outputs.length) throw new Error("未找到可用 MIDI 输入/输出设备");

  const selected = selectTargetPorts(inputs, outputs);
  const output = selected.output;
  const input = selected.input;

  state.midiAccess = midiAccess;
  state.input = input;
  state.output = output;
  state.transportType = "webmidi";
  state.sendPacket = async (command) => {
    state.output.send(command);
  };
  input.onmidimessage = onMidiMessage;

  const selectedName = selected.displayName || getMidiDisplayName(output) || getMidiDisplayName(input) || "未知设备";
  const modelName = resolveDisplayModel(selectedName);
  state.rawDisplayName = modelName;
  setConnected(true, modelName);
  log(`设备已连接: ${modelName}`);
  log(`MIDI枚举: inputs=${inputs.length}, outputs=${outputs.length}`);
  logPortList(inputs, outputs);
  log(`端口选择策略: ${selected.reason}`);
  log(`选中输入: name=${input.name || ""} manufacturer=${input.manufacturer || ""} id=${input.id || ""}`);
  log(`选中输出: name=${output.name || ""} manufacturer=${output.manufacturer || ""} id=${output.id || ""}`);
  log(`上报device_model: ${modelName}`);
}

async function connectDevice() {
  try {
    const dev = await connectWebUsbMidi();
    const selectedName = (dev.productName || "").trim() || "USB MIDI Device";
    const modelName = resolveDisplayModel(selectedName);
    state.rawDisplayName = modelName;
    setConnected(true, modelName);
    log(`设备已连接(WebUSB): ${modelName}`);
    log(`WebUSB Device: product=${dev.productName || ""} manufacturer=${dev.manufacturerName || ""}`);
    log(`WebUSB Endpoints: in=${state.usbInEndpoint}, out=${state.usbOutEndpoint}`);
    log(`上报device_model: ${modelName}`);
    return;
  } catch (e) {
    log(`WebUSB连接失败，回退WebMIDI: ${e.message}`);
  }
  await connectMidi();
}

function buildControlCommand(cmd, params = []) {
  const bytes = [0xF0, 0x53, 0x57, cmd & 0xff, params.length & 0xff, ...params, ETX];
  return new Uint8Array(bytes);
}

function buildDataCommand(cmd, pkt, data) {
  return new Uint8Array([0xF0, 0x53, 0x57, cmd & 0xff, pkt & 0xff, ...data, ETX]);
}

function waitForResponse(timeoutMs, matcher) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (state.responseWaiter) state.responseWaiter = null;
      reject(new Error(`等待响应超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    state.responseWaiter = {
      match: matcher || (() => true),
      resolve: (data) => {
        clearTimeout(timer);
        resolve(data);
      },
    };
  });
}

async function sendAndWait(command, timeoutMs = 5000, matcher) {
  if (!state.sendPacket) throw new Error("设备未连接");
  await state.sendPacket(command);
  return await waitForResponse(timeoutMs, matcher);
}

function isUpgradeResponse(data) {
  return data.length >= 6 && data[1] === 0x53 && data[2] === 0x57;
}

function isAck(resp) {
  return resp && resp.length >= 6 && resp[5] === RESP.ACK;
}

function md5Hex(text) {
  // Minimal MD5 implementation adapted for browser usage.
  function cmn(q, a, b, x, s, t) { a = (((a + q) | 0) + ((x + t) | 0)) | 0; return (((a << s) | (a >>> (32 - s))) + b) | 0; }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  function md5blk(s) {
    const md5blks = [];
    for (let i = 0; i < 64; i += 4) md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    return md5blks;
  }
  function md51(s) {
    let n = s.length;
    let statex = [1732584193, -271733879, -1732584194, 271733878];
    let i;
    for (i = 64; i <= n; i += 64) statex = md5cycle(statex, md5blk(s.substring(i - 64, i)));
    s = s.substring(i - 64);
    const tail = new Array(16).fill(0);
    for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
      statex = md5cycle(statex, tail);
      for (let j = 0; j < 16; j++) tail[j] = 0;
    }
    tail[14] = n * 8;
    return md5cycle(statex, tail);
  }
  function md5cycle(x, k) {
    let [a, b, c, d] = x;
    a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586); c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426); c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417); c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101); c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632); c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083); c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690); c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784); c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463); c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353); c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222); c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835); c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415); c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606); c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744); c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379); c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = (x[0] + a) | 0; x[1] = (x[1] + b) | 0; x[2] = (x[2] + c) | 0; x[3] = (x[3] + d) | 0;
    return x;
  }
  function rhex(n) {
    const s = "0123456789abcdef";
    let out = "";
    for (let j = 0; j < 4; j++) out += s[(n >> (j * 8 + 4)) & 0x0f] + s[(n >> (j * 8)) & 0x0f];
    return out;
  }
  return md51(unescape(encodeURIComponent(text))).map(rhex).join("");
}

function getOrCreateUuid() {
  const key = "tuptup_web_uuid";
  const old = localStorage.getItem(key);
  if (old) return old;
  const id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(key, id);
  return id;
}

function getCountryFromLocale(locale) {
  const m = /[-_]([A-Z]{2})$/i.exec(locale || "");
  return m ? m[1].toUpperCase() : "";
}

function buildSignedBody(extraParams) {
  const timestamp = String(Date.now());
  const platform = "ios";
  const signStr = platform + timestamp;
  const key = md5Hex(timestamp);
  const signFull = md5Hex(signStr + key);
  const sign = signFull.substring(11, 18);

  log(`[SIGN] timestamp=${timestamp}`);
  log(`[SIGN] signStr=${signStr}`);
  log(`[SIGN] key(md5(timestamp),32)=${key}`);
  log(`[SIGN] signFull(md5(signStr+key))=${signFull}`);
  log(`[SIGN] sign(substring 11,7)=${sign}`);

  const locale = navigator.language || "zh-CN";
  return {
    sy: String(Math.round(window.screen?.width || window.innerWidth || 0)),
    sx: String(Math.round(window.screen?.height || window.innerHeight || 0)),
    appid: APP_ID,
    build: APP_BUILD,
    pr: "1",
    v: APP_VERSION,
    uuid: getOrCreateUuid(),
    platform,
    locale,
    country: getCountryFromLocale(locale),
    mcc: "65535",
    channel: "AppStore",
    timestamp,
    sign,
    ...extraParams,
  };
}

async function checkFirmware() {
  const body = buildSignedBody({
    device_model: state.rawDisplayName || els.deviceName.textContent,
    current_version: state.currentVersion,
  });
  const formData = new FormData();
  for (const [k, v] of Object.entries(body)) {
    formData.append(k, String(v ?? ""));
  }
  log(`[CHECK] POST ${API_URL}`);
  log(`[CHECK] Request Body(form-data): ${JSON.stringify(body)}`);
  const resp = await fetch(API_URL, {
    method: "POST",
    body: formData,
  });
  const rawText = await resp.text();
  log(`[CHECK] Response Status: ${resp.status}`);
  log(`[CHECK] Response Body: ${rawText.slice(0, 1000)}`);
  if (!resp.ok) throw new Error(`接口错误: HTTP ${resp.status}`);
  let payload;
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    throw new Error("接口返回非 JSON 格式");
  }
  const data = payload?.data;
  if (!data || typeof data.has_update !== "boolean") throw new Error("接口返回结构异常");
  log(`[CHECK] Parsed has_update=${data.has_update}, latest_version=${data.latest_firmware?.firmware_version || "-"}`);
  return data;
}

async function fetchUpgLines(url) {
  const proxyUrl = `${FIRMWARE_PROXY_URL}?url=${encodeURIComponent(url)}`;
  log(`[UPG] Proxy Download: ${proxyUrl}`);
  const resp = await fetch(proxyUrl);
  if (!resp.ok) throw new Error(`下载固件失败: HTTP ${resp.status}`);
  const text = await resp.text();
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function parseUpgText(text) {
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function isCorsLikeError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("failed to fetch") || msg.includes("cors") || msg.includes("networkerror");
}

function isProxyLikelyUnavailable(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  if (location.protocol === "file:") return true;
  return msg.includes("failed to fetch") || msg.includes("networkerror") || msg.includes("load failed");
}

async function transferFirmware(lines) {
  setStage("初始化", 0);
  let resp = await sendAndWait(buildControlCommand(CMD.INIT, []), 5000, isUpgradeResponse);
  if (!isAck(resp)) throw new Error("初始化失败：未收到ACK");

  setStage("传输中", 1);
  for (let i = 0; i < lines.length; i++) {
    const cmd = CMD.DATA_BASE + Math.floor(i / LINES_PER_CMD);
    const pkt = i % LINES_PER_CMD;
    const lineBytes = new TextEncoder().encode(lines[i]);
    const msgSize = 6 + lineBytes.length; // F0 53 57 CMD PKT [data] F7
    if (i < 5) {
      log(`发送行${i + 1}: dataLen=${lineBytes.length}, sysexLen=${msgSize}`);
    }

    let ok = false;
    for (let retry = 1; retry <= MAX_RETRY; retry++) {
      try {
        resp = await sendAndWait(buildDataCommand(cmd, pkt, lineBytes), 5000, isUpgradeResponse);
        if (isAck(resp)) {
          ok = true;
          break;
        }
        if (resp[5] === RESP.CRC_ERROR) log(`第${i + 1}行 CRC 错误，重试 ${retry}/${MAX_RETRY}`);
        else log(`第${i + 1}行 NAK/异常响应，重试 ${retry}/${MAX_RETRY}`);
      } catch {
        log(`第${i + 1}行 超时，重试 ${retry}/${MAX_RETRY}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ok) throw new Error(`数据传输失败，行号 ${i + 1}`);

    if (i % 10 === 0 || i === lines.length - 1) {
      setStage("传输中", Math.floor(((i + 1) * 100) / lines.length));
    }
  }

  setStage("结束中", 99);
  resp = await sendAndWait(buildControlCommand(CMD.FINISH, [0x04]), 10000, isUpgradeResponse);
  if (!isAck(resp)) throw new Error("结束升级失败：未收到ACK");
  setStage("升级成功", 100);
}

els.connectBtn.addEventListener("click", async () => {
  try {
    await connectDevice();
  } catch (e) {
    log(`连接失败: ${e.message}`);
    alert(e.message);
  }
});

els.checkBtn.addEventListener("click", async () => {
  try {
    setStage("检查更新中", 0);
    log("开始检查固件更新...");
    const data = await checkFirmware();
    const fw = data.latest_firmware;
    state.firmwareInfo = fw;
    els.latestVersion.textContent = fw?.firmware_version || "-";
    els.fileSize.textContent = fw?.file_size ? `${(fw.file_size / 1024 / 1024).toFixed(2)} MB` : "-";
    els.releaseNote.textContent = `更新说明：\n${fw?.release_note || "-"}`;
    els.upgradeBtn.disabled = !(data.has_update && fw?.down_url);
    setStage(data.has_update ? "检测到新版本" : "已是最新", 0);
    log(data.has_update ? `发现新版本 ${fw?.firmware_version}` : "当前已是最新版本");
  } catch (e) {
    setStage("检查失败", 0);
    log(`检查失败: ${e.message}`);
    alert(e.message);
  }
});

els.upgradeBtn.addEventListener("click", async () => {
  if (!state.firmwareInfo?.down_url && !state.localFirmwareLines) return;
  try {
    els.upgradeBtn.disabled = true;
    let lines = state.localFirmwareLines;
    if (lines && lines.length) {
      log(`使用本地固件: ${state.localFirmwareName || "(未命名)"}`);
    } else {
      log("开始下载固件...");
      try {
        lines = await fetchUpgLines(state.firmwareInfo.down_url);
      } catch (e) {
        if (isProxyLikelyUnavailable(e)) {
          log("代理下载失败：请确认通过 http://127.0.0.1:8080 打开页面，且 node server.js 正在运行。");
          throw new Error("代理服务不可用，请先启动本地 server.js 并从 127.0.0.1:8080 访问页面");
        }
        if (isCorsLikeError(e)) {
          log("下载失败（可能跨域或网络异常），请检查代理服务日志。");
          throw new Error("固件下载失败，请检查代理服务是否正常");
        }
        throw e;
      }
    }
    if (!lines.length) throw new Error("固件文件为空");
    log(`固件读取完成，共 ${lines.length} 行`);
    await transferFirmware(lines);
    log("升级完成");
  } catch (e) {
    setStage("升级失败", 0);
    log(`升级失败: ${e.message}`);
    alert(e.message);
  } finally {
    els.upgradeBtn.disabled = false;
  }
});

els.pickFileBtn.addEventListener("click", () => {
  els.firmwareFileInput.value = "";
  els.firmwareFileInput.click();
});

els.firmwareFileInput.addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const lines = parseUpgText(text);
    if (!lines.length) throw new Error("本地固件文件为空或格式不正确");
    state.localFirmwareLines = lines;
    state.localFirmwareName = file.name;
    els.upgradeBtn.disabled = false;
    log(`已选择本地固件: ${file.name}，共 ${lines.length} 行`);
  } catch (e) {
    state.localFirmwareLines = null;
    state.localFirmwareName = "";
    log(`读取本地固件失败: ${e.message}`);
    alert(e.message);
  }
});

if (els.currentVersion) els.currentVersion.textContent = state.currentVersion;
setConnected(false);
log("页面已就绪，等待连接钢琴。");
