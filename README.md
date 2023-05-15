# dlinkWebSocketClient

A node.js module used to interface D-Link DSP-W115 and DSP-W245 smartplugs and maybe other devices using the mydlink app.

### Acknowledgment

This work is base on @jonassjoh's work in [dspW245](https://github.com/jonassjoh/dspW245/)
Many thanks for all the good work. I translated it from python to node.js and using websocket/Hybi library. 

### Preparation of device

You will need the Pin or device token of your device. 
The Pin is written on the back of the device or in the quick setup leaflet next to the
QR code. 

If you did pair the device with the app and want to keep the device in the mydlink app,
you will also need the device token. This is a bit nasty to get and it seems that it changes on every 
reboot. So currently I recommend not pairing the device with the app.

#### Use PIN (no mydlink App!)
If you don't need the app, proceed as follows:
1. If needed, remove the device from the mydlink App.
2. Start the process of adding the device to the app
3. Follow the process and in the process let the device join your wifi
4. After the device rebootet and joined your wifi, do **not** finish setup, just **close** the app.
 
 You can now use your Pin and control the device with this library. 

#### Get the device token
If you still want the device in the mydlink app, you will need to enter the device token
in all places where it says "PIN" in the following description. You can get the device token like this:
1. Start device in factory mode. 
   1. Reset device into recovery mode by holding the reset button during boot (i.e. until it starts blinking **red**)
   2. Now a telnet deamon is running, connect to the device wifi
   3. Run `telnet 192.168.0.20` and login with `admin:123456`
   4. Run `nvram_set FactoryMode 1`
   5. Run `reboot; exit;` to reboot the device.
2. If needed, setup the device with th mydlink app as usual (but not necessary to redo).
3. Run `telnet IP_of_device` and login with `admin:123456` again.
4. Run `cat /mydlink/config/device.cfg` and copy the value for `DeviceToken`.

Now use this device token everywhere, where it says "PIN" below. 
Beaware that the telnet port will still be open. You might want to repeat 
step 1 with `nvram_set FactoryMode 0` again. **It seems that the device token
changes every day, though. So keep it open.**

### Usage

Install with `npm install dlink_websocketclient`.

#### Commandline tools
There is a small command line tool that can act as an example or be used in scripts already.
Usage of that tool is like this:
`node switch.js IP PIN 0/1 [Index]` 
Where 0/1 is for socket off/on and optional index to select a socket.
If you are using the app, too, you can now supply TELNET as PIN and it will tell the library to get the token from telnet.
(Of course the telnet port needs to stay active for this to work). 
There is also a new tool getToken.js which will acquire the PIN from telnet and print it on the console.

#### Library
Example for library use:
```javascript
const WebSocketClient = require('dlink_websocketclient');

const client = new WebSocketClient({
    ip: '192.168.0.20', //ip or hostname of the device
    pin: '123456'      //PIN of the device or device token
});

client.on('switched', (newState, socket) => {
    console.log(`Socket ${socket} switched to ${newState}`);
});

client.login().then(async () => {
    const state = await client.state(); //retrieve state of socket
    await client.switch(!state); //toggle socket
});
```

##### Events:
The class extends EventEmitter, so all methods of node.js EventEmitter can be 
used. The following events are emitted:

###### switched
Will be emitted when the plug notifies us of a switch event. 
Parameters are the new state as boolean and the index of the socket.

###### switched-led
Will be emitted if the LED is switched on/off.
Parameters are the new state as boolean and the index of the socket.

###### close
Will be emitted when the socket is closed with parameters code and reason. See [ws](https://www.npmjs.com/package/ws) for details.

###### error
Will be emitted if there is an error with the socket. Parameter is the error that occurred.

###### ready
Emitted when the socket connection is ready to work with (i.e. login is possible).

##### Functions:
###### constructor
The constructor receives an object with the following properties:
```typescript
interface Parameters { 
 ip: string, //ip of the device.
 pin: string, // either Pin on the back or device token (if paired with App! Needs to be extracted, see readme).
 port: number, //optional defaults to 8080
 model: string, //optional either w115 or w245.
 log: function, //optional, pass function for debug logging, defaults to noop.
 keepAlive: number, //options, interval in seconds to ping. Defaults to 30. Use 0 to turn off.
 useTelnetForToken: boolean //if true, in the login command, the library will try to get the token by connecting via telnet.
}
```

###### connect / disconnect
No parameters. Starts / Stops socket connection.
connect returns a promise that will resolve when the connection is ready to use (i.e. login is possible)

###### getTokenFromTelnet
Helper function to connect to telnet and extract the token from telnet. It seems token changes every day on W115. So
we can just get it from telnet when needed.

###### getDeviceInfoFromTelnet
Helper function to connect to telnet and extract device info from telnet. Will return an object with 
model, mac and hardwareVersion, firmwareVersion, softwareVersion as properties. 

###### setPin
You can start the device with a wrong / without PIN and query MAC/deviceId already. Whit the setPin function you can
change the Pin that the library uses to authenticate with the device, so you do not have to recreate the connection in
those cases.

###### login
Logs in to the device. Will call connect, if not already done. Returns promise.

###### isDeviceReady
Returns true if socket is connected and ready to use.

###### switch
Switches the socket. 
Parameters are `on: boolean, socket: numer = 0`.
`on` is the target value.
`socket` is optional and can be used with DSP-W245 to select socket to switch.
Returns promise which will be resolved to the new state.

###### switchLED
Switches the led on/off. 
Parameters are `on: boolean, led: numer = 0`.
`on` is the target value.
`led` is optional and can be used with DSP-W245 to select led to switch.
Returns promise which will be resolved to the new state.

###### state
Queries the current state of the socket(s).  
The only paramter `socket: number = 0` is optional and used to select a result
value. It defaults to 0, so state of first socket is returned. Set to -1 to
get the results of all sockets as array of booleans.
Returns a promise.

#### Contribution
Contribution is very welcome. @jonassjoh learned about the protocol by reverse engineering 
da_adaptor binary in the firmware. I tried to poke around a bit there, too, but failed. If you
know your way around such things, I'd be very happy to gather more information about the protocol
(for example it would be nice to query the device about its capabilities and find a way
to not require the device token, which changes each boot, it seems).

Please feel free to open an issue with any information you can provide or reach me at garfonso@mobo.info.

Of course I'm also very glad about issues and pull requests if you find a bug / have an improvement in the code itself. 

## Changelog
<!-- 
	Placeholder for next versions (this needs to be indented):
	### __WORK IN PROGRESS__
-->
### 0.5.5 (2023-05-15)
* prevent issue with multiple start/stop calls on the same device.

### 0.5.4 (2023-04-28)
* fix 'Server sent no subprotocol' error and ignore ts warnings.

### 0.5.3 (2023-04-28)
* fix d.ts

### 0.5.2 (2023-04-17)
* add d.ts for typescript support.

### 0.5.1 (2022-08-30)
* fix support for ws 8.*

### 0.5.0 (2022-08-30)
* add / repair support for multiple sockets.

### 0.4.2 (2021-11-23)
* update dependencies.
* improve error handling on login.
* improve switch.js example

### 0.4.0 (2020-06-01)
* added possibility to change / setPin on existing device (locally!)
* improved exceptions by reporting error code.

### 0.3.0 (2020-05-30)
* added getDeviceInfoFromTelnet function
* fixed ping functionality.

### 0.2.1 (2020-05-17)
* Remove debug logging from switch.js

### 0.2.0 (2020-05-17)
* add getToken.js
* add useTelnetForToken in library and adjust switch.js to use if

### 0.1.0 (2020-05-16)
* initial public release
