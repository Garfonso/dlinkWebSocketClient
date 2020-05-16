
const crypto = require('crypto');
const WebSocket = require('ws');
const EventEmitter = require('events');

//some constants:
const TYPE_SOCKET = 16;
const TYPE_LED = 41;

/**
 * @typedef WebSocketClean
 * @type {Object}
 * @property {function} send
 * @property {number} readyState
 * @property {function} ping
 * @property {function} close
 * @property {function} terminate
 *
 * @typedef {import("net").Socket} Socket
 * @typedef {WebSocketClean & Socket} WebSocket
 */

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
            socket: /** @type {WebSocket} */ ({}),
            pingHandler: /** @type {NodeJS.Timeout|undefined} */ (undefined),
            sequence: 1000,
            state: [false]
        };
        this._device.state = this._device.model === 'w245' ? [false, false, false, false] : [false];
    }

    //private functions:
    /**
     * Called when data is received.
     * @param {string} data
     */
    _receiveData(data) {
        const message = JSON.parse(data);
        this._device.debug('Got message: ', message);
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
        this._device.pingHandler = setTimeout(this._ping, this._device.keepAlive * 1000);
    }

    /**
     * Connects via socket.
     */
    connect() {
        return new Promise((resolve, reject) => {
            this._device.socket = new WebSocket('https://' + this._device.ip + ':' + this._device.port + '/SwitchCamera', {
                protocolVersion: 13,
                rejectUnauthorized: false,
                timeout: 5000
            });
            this._device.socket.on('close', (code, reason) => {
                this._device.debug('Socket closed: ' + reason + '(' + code + ')');
                this._device.connected = false;
                this.emit('close', code, reason);
                reject(new Error(`Socket closed: ${reason} (${code})`));
            });
            this._device.socket.on('error', (e) => {
                this._device.debug('Socket error:', e);
                this._device.connected = false;
                this.emit('error', e);
                reject(new Error('Socket error: ' + e));
            });
            this._device.socket.on('open', () => {
                this._device.debug('Socket open');
                this.emit('ready');
                resolve(true);
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
        if (this._device.socket) {
            this._device.socket.close();
            setTimeout(this._device.socket.terminate, 500); //force close after some time.
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
        d.sequence_id = this._device.sequence; // Does not matter.
        d.local_cid = 41556;  // Does not matter.
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
            function handleMessage(messageText) {
                const message = JSON.parse(messageText);
                if (message.sequence_id !== expectedSequence) {
                    that._device.debug('Unexpected message with sequence_id: ' + message.sequence_id);
                } else {
                    resolve(message);
                    that._device.socket.removeListener('message', handleMessage);
                }
            }

            that._device.socket.on('message', handleMessage.bind(this));
            that._device.socket.once('close', (code, reason) => reject(new Error(`Socket closed: ${reason} (${code})`)));
            that._device.socket.once('error', (error) => reject(new Error('Socket error: ' + error)));
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
     * Gets device status of type
     * @param {number} type led or socket supported.
     * @returns {Promise<Array<{uid: number, metadata: {value: number}, idx: number, type: number}>>}
     * @private
     */
    async _getSetting(type){
        const message = await this._sendJsonAsync({
            command: 'get_setting',
            setting:[{
                type: type
            }]
        });
        if (message.code !== 0) {
            throw new Error(`API Error ${message.code}: ${message.message}`);
        }
        return message.setting; //array of settings -> should be all for w245?
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
        this._device.debug('Connected. Signing in.');
        const message = await this._sendJsonAsync({command: 'sign_in'});
        this._device.salt = message.salt;
        this._device.deviceId = message.device_id;
        this._device.shortId = this._device.deviceId.substring(this._device.deviceId.length - 4);
        this._device.connected = true;
        return true;
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
        const settings = await this._getSetting(TYPE_SOCKET);
        if (socket >= 0) {
            return settings[socket].metadata.value === 1;
        }
        const result = [];
        for (const s of settings) {
            result.push(s.metadata.value === 1);
        }
        return result;
    }
}

module.exports = WebSocketClient;

