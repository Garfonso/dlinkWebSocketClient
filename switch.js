/**
 * Use this to switch socket from command line like:
 * node switch.js IP PIN 0/1 [Index]
 */

const util = require('util');

const WebSocketClient = require('./index');

if (process.argv.length < 5) {
    console.log('Too few parameters: ' + JSON.stringify(process.argv));
    console.log('Supply TELNET as PIN to get token from telnet programatically.');
    console.log('Usage: node switch.js IP PIN 0/1 [index] - index defaults to 0');
    process.exit(-1);
}
const ip = process.argv[2];
const pin = process.argv[3];
const value = Number.parseInt(process.argv[4], 10);
const index = Number.parseInt(process.argv[5], 10) || 0;

async function main() {
    const client = new WebSocketClient({
        ip: ip,
        pin: pin,
        useTelnetForToken: pin === 'TELNET',
        log: console.log
    });

    client.on('switched', (newState, socket) => {
        console.log(`Socket ${socket} switched to ${newState}`);
    });
    await client.login();
    console.log('Signed in!');


    console.log('Getting state');
    let state = await client.state(index);
    if (state instanceof Array) {
        console.log('Socket states: ', state);
    } else {
        console.log('Socket is ' + (state ? 'on' : 'off'));
    }

    //await client.switchLED(value === 1, index);
    //console.log(util.inspect(result, {showHidden: false, depth: null, colors: true}));

    const newValue = await client.switch(value === 1, index);
    console.log('Socket now is ' + (newValue ? 'on' : 'off'));
    process.exit(0);
}

main().catch((e) => {
    console.error('Had error:', e);
    process.exit(-1);
});
