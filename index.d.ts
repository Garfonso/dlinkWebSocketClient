import {EventEmitter} from 'events';

export = WebSocketClient;
declare class WebSocketClient extends EventEmitter.EventEmitter {
    constructor(options: {
        /**
         * ip of device as string
         */
        ip: string
        /**
         * either Pin on the back or device token (if paired with App! Needs to be extracted, see readme).
         */
        pin: string;

        /**
         * defaults to 8080
         */
        port?: number;

        /**
         * either w115 or w245.
         */
        model?: string;

        /**
         * function for debug logging, defaults to noop.
         */
        log?: (string) => void;

        /**
         * seconds to ping, defaults to 30. 0 to turn off.
         */
        keepAlive?: number;

        /**
         * library should get the device token from telnet (which needs to be active).
         */
        useTelnetForToken?: boolean;
    });

    connect(): Promise<boolean>;

    disconnect(): void;

    getDeviceId(): string;

    getDeviceInfoFromTelnet(): Promise<Record<string, string>>;

    getTokenFromTelnet(): Promise<boolean>;

    login(): Promise<boolean>;

    setPin(newPin: string): void;

    isDeviceReady(): boolean;

    switch(on: boolean, socket?: number): Promise<boolean>;

    switchLED(on: boolean, led?: number): Promise<boolean>;

    state(socket?: number): Promise<boolean | Array<boolean> >;
}