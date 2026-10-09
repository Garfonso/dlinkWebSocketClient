/**
 * Tests the client against a fake device (websocket server via TLS like the real device).
 * Run with: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const selfsigned = require('selfsigned');
const { WebSocketServer } = require('ws');
const WebSocketClient = require('../index.js');

const PIN = '123456';
const DEVICE_ID = 'AABBCCDDEEFF';
const fakeDevice = { silent: false };
const servers = [];

/**
 * Starts a fake device. It sends a new salt on every sign in and checks the device token.
 * Like the real device, it does not answer websocket pings.
 * @param {boolean} answerKeepAlive answer keep_alive commands
 * @returns {Promise<{port: number, wss: WebSocketServer}>}
 */
async function startFakeDevice(answerKeepAlive) {
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048 });
    const server = https.createServer({ key: pems.private, cert: pems.cert });
    const wss = new WebSocketServer({ server, path: '/SwitchCamera', autoPong: false });
    wss.on('connection', ws => {
        let salt = '';
        ws.on('message', raw => {
            const message = JSON.parse(raw.toString());
            const answer = { command: message.command, sequence_id: message.sequence_id, code: 0 };
            if (message.command === 'keep_alive') {
                if (!answerKeepAlive) {
                    return;
                }
            } else if (message.command === 'sign_in') {
                salt = crypto.randomBytes(16).toString('hex');
                Object.assign(answer, { salt, device_id: DEVICE_ID, local_cid: 1 });
            } else {
                if (fakeDevice.silent) {
                    return;
                }
                const token = DEVICE_ID + '-' + crypto.createHash('sha1').update(PIN).update(salt).digest('hex');
                if (message.device_token !== token) {
                    Object.assign(answer, { code: 424, message: 'invalid device token' });
                } else {
                    answer.setting = [{ type: 16, idx: 0, metadata: { value: 1 } }];
                }
            }
            ws.send(JSON.stringify(answer));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push({ server, wss });
    // @ts-ignore - address is an object when listening on a port.
    return { port: server.address().port, wss };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let device;
let deviceWithoutKeepAlive;
const createClient = (port, options = {}) => new WebSocketClient({ ip: '127.0.0.1', port, pin: PIN, ...options });

before(async () => {
    device = await startFakeDevice(true);
    deviceWithoutKeepAlive = await startFakeDevice(false);
});

after(() => {
    for (const { server, wss } of servers) {
        for (const ws of wss.clients) {
            ws.terminate();
        }
        server.close();
    }
});

test('generates new device token after the device sent a new salt', async () => {
    const client = createClient(device.port);
    await client.login();
    assert.strictEqual(await client.state(), true);
    for (const ws of device.wss.clients) {
        ws.terminate(); //like a reboot of the device
    }
    await sleep(100);
    await client.login();
    assert.strictEqual(await client.state(), true);
    client.disconnect();
});

test('rejects request without answer after timeout and removes listeners', async () => {
    const client = createClient(device.port, { timeout: 1 });
    await client.login();
    fakeDevice.silent = true;
    try {
        await assert.rejects(client.state(), { code: 'ETIMEDOUT' });
    } finally {
        fakeDevice.silent = false;
    }
    assert.strictEqual(client.listenerCount('message'), 0);
    assert.strictEqual(client.listenerCount('close'), 0);
    assert.strictEqual(client.listenerCount('error'), 0);
    client.disconnect();
});

test('keeps connection open while keep_alive is answered', async () => {
    const client = createClient(device.port, { keepAlive: 1 });
    let closed = false;
    client.on('close', () => closed = true);
    await client.login();
    await sleep(3500);
    assert.strictEqual(closed, false);
    assert.strictEqual(client.isDeviceReady(), true);
    assert.strictEqual(await client.state(), true);
    client.disconnect();
});

test('closes connection if keep_alive is not answered', async () => {
    const client = createClient(deviceWithoutKeepAlive.port, { keepAlive: 1 });
    const closed = new Promise(resolve => client.on('close', resolve));
    await client.login();
    const code = await Promise.race([closed, sleep(5000).then(() => 'no close event')]);
    assert.strictEqual(code, 1006);
    assert.strictEqual(client.isDeviceReady(), false);
    client.disconnect();
});

test('rejects request if not connected', async () => {
    const client = createClient(device.port);
    await client.login();
    client.disconnect();
    await assert.rejects(client.state(), { code: 'ENOTCONN' });
});

test('does not throw on socket error without error listener', async () => {
    const client = createClient(device.port);
    await client.login();
    assert.doesNotThrow(() => client._device.socket.emit('error', new Error('test error')));
    client.disconnect();
});

test('ignores close of previous socket after reconnect', async () => {
    const client = createClient(device.port);
    let closeEvents = 0;
    client.on('close', () => closeEvents++);
    await client.login();
    const oldSocket = client._device.socket;
    await client.connect();
    await client.login();
    oldSocket.close();
    await sleep(200);
    assert.strictEqual(closeEvents, 0);
    assert.strictEqual(client.isDeviceReady(), true);
    assert.strictEqual(await client.state(), true);
    client.disconnect();
});

test('keepAlive 0 turns off pings', async () => {
    const client = createClient(device.port, { keepAlive: 0 });
    await client.login();
    assert.strictEqual(client._device.pingHandler, undefined);
    client.disconnect();
});

test('invalid device token is reported with code 403', async () => {
    const client = createClient(device.port);
    await client.login();
    client._device.token = 'wrong';
    await assert.rejects(client.state(), { code: 403 });
    await assert.rejects(client.switch(true), { code: 403 });
    client.disconnect();
});

test('connection errors have a code', async () => {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    await assert.rejects(createClient(port).login(), { code: 'ECONNREFUSED' });
});

test('handshake timeout has code ETIMEDOUT', async () => {
    //accepts tcp connections, but never answers.
    const sockets = [];
    const server = net.createServer(socket => sockets.push(socket));
    await new Promise(resolve => server.listen(0, resolve));
    try {
        await assert.rejects(createClient(server.address().port).login(), { code: 'ETIMEDOUT' });
    } finally {
        sockets.forEach(socket => socket.destroy());
        server.close();
    }
});
