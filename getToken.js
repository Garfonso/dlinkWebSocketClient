
const net = require('net');

if (!process.argv[2]) {
    console.log('Please supply IP as parameter!');
    process.exit(-2);
}
const s = net.createConnection(23, process.argv[2], () => {
    console.log('Connected.');
});

s.on('data', buffer => {
    const d = buffer.toString('utf-8');
    if (d.toLowerCase().includes('login:')) {
        console.log('Sending login.');
        s.write(Buffer.from('admin\n'));
    }
    if (d.toLowerCase().includes('password:')) {
        console.log('Sending password.');
        s.write(Buffer.from('123456\n'));
    }
    if (d.includes('DeviceToken')) {
        const pairs = d.split(',');
        for (const pair of pairs) {
            const [key, value] = pair.split(':');
            if (key === '"DeviceToken"') {
                console.log('Got token: ' + value);
                process.exit(0);
            }
        }
        process.exit(-1);
    }
    if (d.includes('#')) {
        console.log('Sending command.');
        s.write(Buffer.from('cat /mydlink/config/device.cfg\n'));
    }
});
s.on('close', () => console.log('Closed.'));
s.on('error', (e) => console.log('Error:', e));
s.on('end', () => console.log('Ended.'));

s.on('ready', () => {
    console.log('Ready.');
});
