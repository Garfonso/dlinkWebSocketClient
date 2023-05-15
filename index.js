
const crypto = require('crypto');
const WebSocket = require('ws');
const EventEmitter = require('events');
const util = require('util');

/* globals Buffer */

//type constants:
const TYPE_SOCKET = 16;
const TYPE_LED = 41;
//still unknown types, but used in app:
// 1, 2, 30, 33, 34 => extract only id.
// 61, 62: reads metadata and from that idx and type.. but not value (?)
// 500, 501: ready type from metadata
// 39, 42, 43, 45, 46: reads "total" & "free" from metadata.
// 70, 73, 74, 76, 77: reads "total" & "free" & "mount_path" from metadata.
// 60: reads id and mydlink_no
// 10000: seems to be text message?
// 22, 400: "model", "nickname", "photo_index" read from event.
// 1, 4, 0: code from message and if fitting (?) channel_url and some more stuff.

function noop() {}

class WebSocketClient extends EventEmitter.EventEmitter {
    /**
     * Creates a webSocketClient.
     * @typedef Parameters
     * @type {Object}
     * @property {string} ip
     * @property {string} pin either Pin on the back or device token (if paired with App! Needs to be extracted, see readme).
     * @property {number} [port] defaults to 8080
     * @property {string} [model] either w115 or w245.
     * @property {function} [log] function for debug logging, defaults to noop.
     * @property {number} [keepAlive] seconds to ping, defaults to 30. 0 to turn off.
     * @property {boolean} [useTelnetForToken] library should get the device token from telnet (which needs to be active).
     *
     * @param {Parameters} opt - parameters, must have url, user and password.
     */
    constructor(opt) {
        super();
        this._device = {
            ip: opt.ip || '',
            pin: opt.pin || '',
            model: opt.model || '',
            port: opt.port || 8080,
            debug: opt.log || noop,
            keepAlive: opt.keepAlive || 30,
            deviceToken: '',
            deviceId: '',
            salt: '',
            socket: {},
            pingHandler: /** @type {NodeJS.Timeout|undefined} */ (undefined),
            sequence: 1000,
            state: [false],
            useTelnetForToken: opt.useTelnetForToken
        };
        this._device.state = this._device.model === 'w245' ? [false, false, false, false] : [false];
    }

    //private functions:
    /**
     * Called when data is received.
     * @param {string} data
     */
    _receiveData(data) {
        this.emit('message', data);
        const message = JSON.parse(data);
        this._device.debug('Got message: ', util.inspect(message, {showHidden: false, depth: null, colors: true}));
        if (message.command === 'event' && message.event && message.event.metadata) {
            if (message.event.metadata.type === TYPE_SOCKET) {
                this._device.debug(`Socket ${message.event.metadata.idx} now ${message.event.metadata.value}`);
                this.emit('switched', message.event.metadata.value === 1, message.event.metadata.idx);
            } else if (message.event.metadata.type === TYPE_LED) {
                this.emit('switched-led', message.event.metadata.value === 1, message.event.metadata.idx);
            }
        }
    }

    _ping() {
        if (this._device.pingHandler) {
            clearTimeout(this._device.pingHandler);
        }
        if (this._device.socket && this._device.socket.readyState === WebSocket.OPEN) {
            const data = {
                command: 'keep_alive'
            };
            this._device.socket.ping(JSON.stringify(data));
        }
        this._device.pingHandler = setTimeout(this._ping.bind(this), this._device.keepAlive * 1000);
    }

    /**
     * Connects via socket.
     */
    connect() {
        let resolved = false;
        return new Promise((resolve, reject) => {
            this._device.socket = new WebSocket('wss://' + this._device.ip + ':' + this._device.port + '/SwitchCamera', {
                // @ts-ignore -> we need to ignore here, because we must not set subprotocols, server does not set subprotocols, so we can't either or we get an error "Server sent no subprotocol" and connection is closed by ws. The code currently accepts omitting the subprotocols this way, even if the type definitions don't allow it.
                rejectUnauthorized: false,
                timeout: 5000
            });
            this._device.socket.on('close', (code, reason) => {
                this._device.debug('Socket closed: ' + reason + '(' + code + ')');
                this._device.connected = false;
                if (resolved) {
                    this.emit('close', code, reason);
                } else {
                    reject(new Error(`Socket closed: ${reason} (${code})`));
                    resolved = true;
                }
            });
            this._device.socket.on('error', (e) => {
                this._device.debug('Socket error:', e);
                this._device.connected = false;
                if (resolved) {
                    this.emit('error', e);
                } else {
                    reject(new Error('Socket error: ' + e));
                    resolved = true;
                }
            });
            this._device.socket.on('open', () => {
                this._device.debug('Socket open');
                resolve(true);
                resolved = true;
                this.emit('ready');
            });
            this._device.socket.on('message', this._receiveData.bind(this));
            this._device.socket.on('unexpected-response', (request, response) => this._device.debug('Unexpected response: ', response, 'to', request));

            if (this._device.keepAlive > 0) {
                this._ping();
            }
        });
    }

    /**
     * Ends socket connection
     */
    disconnect() {
        const socket = this._device.socket; //keep copy of socket here. Might want to reconnect, then terminate is not good, might be called on new socket.
        if (socket && typeof socket.close === 'function') {
            socket.close();
            this._device.debug('Socket closing, demanded by calling diconnect()');
            setTimeout(() => {
                if (socket && socket.terminate === 'function') {
                    try {
                        socket.terminate();
                        this._device.debug('Socket terminated, demanded by calling diconnect()');
                    } catch (e) {
                        this._device.debug('Could not terminate socket: ' + e.stack);
                    }
                }
            }, 500); //force close after some time
        }
        if (this._device.pingHandler) {
            clearTimeout(this._device.pingHandler);
        }
        this._device.connected = false;
    }

    /**
     * Generates device token from pin and salt (salt needs to be retrieved first).
     * The token is cached.
     * @returns {string}
     * @private
     */
    _generateDeviceToken() {
        if (!this._device.token && this._device.salt && this._device.deviceId) {
            const shasum = crypto.createHash('sha1');
            shasum.update(this._device.pin);
            shasum.update(this._device.salt);
            this._device.token = this._device.deviceId + '-' + shasum.digest('hex');
        }
        return this._device.token;
    }

    /**
     * Augment JSON command with additional fields that are required by server
     * @param {Object} data should have "command" property as string.
     * @returns {Object}
     * @private
     */
    _buildJSON(data) {
        const d = data || {};
        this._device.sequence += 1;
        d.sequence_id = this._device.sequence;
        d.local_cid = this._device.localCid;
        d.timestamp = Math.round(Date.now() / 1000);
        d.client_id = '';
        if (this._device.deviceId) {
            d.device_id = this._device.deviceId;
            d.device_token = this._generateDeviceToken();
        }
        return d;
    }

    /**
     * Sends JSON data (as object) via socket.
     * @param {Record<string, any>} data
     * @returns {number} sequence_id of packet send. Check incomming messages for sequence_id to find answer
     * @private
     */
    _sendJson(data) {
        //augment data:
        const obj = this._buildJSON(data);
        const toSend = JSON.stringify(obj);
        this._device.socket.send(toSend, () => this._device.debug(toSend, 'written.'));
        return this._device.sequence;
    }

    /**
     * Sends command JSON asynchronoulsy. Resolves with incomming message or is rejected with error,
     * @param data
     * @returns {Promise<Record<string, any>>}
     * @private
     */
    _sendJsonAsync(data) {
        return new Promise((resolve, reject) => {
            const that = this;
            const handleMessage = function (messageText) {
                const message = JSON.parse(messageText);
                if (message.sequence_id !== expectedSequence) {
                    that._device.debug('Unexpected message with sequence_id: ' + message.sequence_id);
                } else {
                    that.removeListener('message', handleMessage);
                    that.removeListener('error', handleError);
                    that.removeListener('close', handleError);
                    resolve(message);
                }
            }.bind(this);
            const handleError = function (code, reason) {
                that.removeListener('message', handleMessage);
                that.removeListener('error', handleError);
                that.removeListener('close', handleError);
                if (code < 0) {
                    reject(reason); //error
                } else {
                    reject(new Error(`Socket closed: ${reason} (${code})`));
                }
            }.bind(this);

            that.on('message', handleMessage);
            that.once('close', handleError);
            that.once('error', handleError);
            const expectedSequence = this._sendJson(data);
        });
    }

    /**
     * Switch socket or LED on device.
     * @param {number} value 0 for off, 1 for on
     * @param {number} socket index of socket
     * @param {number} type led or socket currently supported.
     * @returns {Promise<boolean>} new value of socket or led as boolean
     * @private
     */
    async _setSetting(value, socket, type){
        const message = await this._sendJsonAsync({
            command: 'set_setting',
            setting:[{
                uid: 0,
                metadata: {
                    value: value
                },
                //name: `DSP-${device.model}-${device.shortId}-${socket}`,
                idx: socket,
                type: type
            }]
        });
        if (message.code !== 0) {
            throw new Error(`API Error ${message.code}: ${message.message}`);
        }
        return message.setting[0].metadata.value === 1; //array of settings -> we switch one by one. So it should always be just one?
    }

    /**
     * @typedef MetaDataSingle
     * @type {object}
     * @property {number} [idx]
     * @property {number} value
     */
    /**
     * @typedef MetaDataMultiple
     * @type {object}
     * @property {Array<{idx: number, metadata: {value: number}}>} value
     */
    /**
     * Result of get settings call, settings[0] will always be filled with this. Either one medatada.value or an array of metadata.values with idx and metadata.value for socket state.
     * @typedef SettingsResult
     * @type {object}
     * @property {number} type
     * @property {number} [uid]
     * @property {number} idx
     * @property {MetaDataSingle|MetaDataMultiple} metadata
     */

    /**
     * Gets device status of type
     * @param {number} type led or socket supported.
     * @param {number} [socket] socket to get setting for.
     * @returns {Promise<Array<SettingsResult>>}
     * @private
     */
    async _getSetting(type, socket = 0){
        const message = await this._sendJsonAsync({
            command: 'get_setting',
            setting:[{
                type: type,
                idx: socket
            }]
        });
        if (message.code !== 0) {
            const error = new Error(`API Error ${message.code}: ${message.message}`);
            // @ts-ignore - no code property in message...
            error.code = message.code;
            if (message.code === 424) {
                // @ts-ignore - no code property in message...
                error.code = 403; //make invalid credentials more clear.
            }
            throw error;
        }
        return message.setting; //array of settings -> should be all for w245?
    }

    /**
     * Returns device id (MAC address stripped of :).
     * Works after login.
     * @returns {string}
     */
    getDeviceId() {
        return this._device.deviceId;
    }

    /**
     * Get file contents via telnet connection, device needs to have telnet server activated.
     * @param {string} file
     * @param {string} searchString
     * @returns {Promise<string>}
     * @private
     */
    async _getFileContentsFromTelnet(file, searchString){
        return new Promise((resolve, reject) => {
            const net = require('net');
            const s = net.createConnection(23, this._device.ip);

            s.on('data', buffer => {
                const d = buffer.toString('utf-8');
                if (d.toLowerCase().includes('login:')) {
                    this._device.debug('Telnet: Sending login.');
                    s.write(Buffer.from('admin\n'));
                }
                if (d.toLowerCase().includes('password:')) {
                    this._device.debug('Telnet: Sending password.');
                    s.write(Buffer.from('123456\n'));
                }
                if (d.includes(searchString)) {
                    s.end(Buffer.from('\x04'));
                    resolve(d);
                }
                if (d.includes('#')) {
                    this._device.debug('Telnet: Sending command.');
                    s.write(Buffer.from('cat ' + file + '\n'));
                }
            });
            s.on('close', () => reject(new Error('Connection closed.')));
            s.on('error', (e) => reject(e));
            s.on('end', () => reject(new Error('Connection ended.')));

            s.on('ready', () => {
                this._device.debug('Telnet: Ready.');
            });
        });
    }

    /**
     * Get Device info like Model and MAC from telnet.
     * @returns {Promise<{}>}
     */
    async getDeviceInfoFromTelnet() {
        const d = await this._getFileContentsFromTelnet('/mydlink/config/mdns/mdns.conf','_dcp._tcp. local.' );
        const lines = d.split('\n');
        const deviceInfo = {};
        for (const line of lines) {
            const [key, value] = line.split('=');
            if (key === 'mac') {
                deviceInfo.mac = value;
            } else if (key === 'model') {
                this._device.model = value.substring(value.indexOf('-') + 1);
                deviceInfo.model = value;
            } else if (key === 'hw_ver') {
                deviceInfo.hardwareVersion = value;
            } else if (key === 'fw_ver') {
                deviceInfo.firmwareVersion = value;
            } else if (key === 'md_ver') {
                deviceInfo.softwareVersion = value;
            }
        }
        return deviceInfo;
    }

    /**
     * Use open telnet port and known credentials to get the device_token. For this you need to follow the procedure
     * in the readme to prepare the device, before.
     * @returns {Promise<boolean>}
     */
    async getTokenFromTelnet() {
        const d = await this._getFileContentsFromTelnet('/mydlink/config/device.cfg','DeviceToken' );
        const pairs = d.split(',');
        for (const pair of pairs) {
            const [key, value] = pair.split(':');
            if (key === '"DeviceToken"') {
                this._device.pin = value.substring(1, value.length - 1); //remove quotes.
                this._device.debug('Telnet: Got token: ' + this._device.pin);
                return true;
            }
        }
        throw new Error('No token found.');
    }

    /**
     * Login to device. Will get salt and device_id.
     * @returns {Promise<boolean>}
     */
    async login() {
        if (!this._device.socket || this._device.socket.readyState !== WebSocket.OPEN) {
            this._device.debug('Need to connect. Doing that now.');
            await this.connect();
        }
        if (this._device.useTelnetForToken) {
            await this.getTokenFromTelnet();
        }
        this._device.debug('Connected. Signing in.');
        //scope found in app on 2022-01-03
        const message = await this._sendJsonAsync({command: 'sign_in', scope:['user', 'device:status', 'device:control', 'viewing', 'photo', 'policy', 'client', 'event']});
        try {
            this._device.salt = message.salt;
            this._device.deviceId = message.device_id;
            this._device.localCid = message.local_cid;
            this._device.shortId = this._device.deviceId.substring(this._device.deviceId.length - 4);
            this._device.connected = true;
            this._device.debug('Connection successful.');
            return true;
        } catch (e) {
            throw new Error('Could not process login answer, got this answer: ' + JSON.stringify(message));
        }
    }

    /**
     * Allows to change the pin later on. Will clear token so a new one is generated.
     * @param {string} newPin
     */
    setPin(newPin) {
        this._device.token = '';
        this._device.pin = newPin;
    }

    /**
     * Returns true if device ready
     * @returns {boolean}
     */
    isDeviceReady() {
        return this._device.connected;
    }

    /**
     * Switches a socket (0 for DSP-W115 or 0-3 for DSP-W245)
     * @param {boolean} on target state
     * @param {number} [socket] to switch, defaults to 0
     * @returns {Promise<boolean>} new state
     */
    async switch(on, socket = 0) {
        if (socket < 0) {
            throw new Error('Can not set socket ' + socket + '. Please supply positive index.');
        }
        return this._setSetting(on ? 1 : 0, socket, TYPE_SOCKET);
    }

    /**
     * Switches an LED (0 for DSP-W115 or 0-3 for DSP-W245)
     * @param {boolean} [on] target state, defaults to false
     * @param {number} [led] to switch, defaults to 0
     * @returns {Promise<boolean>} new state
     */
    async switchLED(on = false, led = 0) {
        return this._setSetting(on ? 1 : 0, led, TYPE_LED);
    }

    /**
     * Query state of socket
     * @param {number} [socket] socket between 0 and 3 (for w245), defaults to 0. Supply -1 to get all sockets.
     * @returns {Promise<boolean|Array<boolean>>}
     */
    async state (socket = 0) {
        const settings = await this._getSetting(TYPE_SOCKET, socket);
        if (socket >= 0) {
            //seems to be 0 anyway..
            return settings[0].metadata.value === 1;
        }
        const result = [];
        const metadata = /** @type MetaDataMultiple */ (settings[0].metadata);
        for (const value of metadata.value) {
            result[value.idx] = value.metadata.value === 1;
        }
        return result;
    }

    /**
     * For development needs.. try new / unknown methods.
     * @param command
     * @param parameters
     * @returns {Promise<Record<string, *>>}
     */
    async testCommand(command, parameters = {}) {
        parameters.command = command;
        if (!this._device.connected) {
            this._device.debug('Need to build connection, doing that.');
            await this.connect();
        }
        return await this._sendJsonAsync(parameters);
    }
}

module.exports = WebSocketClient;

