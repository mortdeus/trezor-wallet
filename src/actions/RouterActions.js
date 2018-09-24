/* @flow */

import { push, LOCATION_CHANGE } from 'react-router-redux';
import { routes } from 'support/routes';

import type {
    RouterLocationState,
    Device,
    TrezorDevice,
    ThunkAction,
    PayloadAction,
    Dispatch,
    GetState,
} from 'flowtype';
import type { RouterAction } from 'react-router-redux';

/*
* Parse url string to RouterLocationState object (key/value)
*/
export const pathToParams = (path: string): PayloadAction<RouterLocationState> => (): RouterLocationState => {
    // split url into parts
    const parts: Array<string> = path.split('/').slice(1);
    const params: RouterLocationState = {};
    // return empty params
    if (parts.length < 1 || path === '/') return params;

    // map parts to params by key/value
    // assuming that url is in format: "/key/value"
    for (let i = 0, len = parts.length; i < len; i += 2) {
        params[parts[i]] = parts[i + 1] || parts[i];
    }

    // check for special case: /device/device-id:instance-id
    if (params.hasOwnProperty('device')) {
        const isClonedDevice: Array<string> = params.device.split(':');
        if (isClonedDevice.length > 1) {
            const [device, instance] = isClonedDevice;
            params.device = device;
            params.deviceInstance = instance;
        }
    }
    return params;
};

/*
* RouterLocationState validation
* Check if requested device or network exists in reducers
*/
export const paramsValidation = (params: RouterLocationState): PayloadAction<boolean> => (dispatch: Dispatch, getState: GetState): boolean => {
    // validate requested device
    if (params.hasOwnProperty('device')) {
        const { devices } = getState();

        let device: ?TrezorDevice;
        if (params.hasOwnProperty('deviceInstance')) {
            device = devices.find(d => d.features && d.features.device_id === params.device && d.instance === parseInt(params.deviceInstance, 10));
        } else {
            device = devices.find(d => d.path === params.device || (d.features && d.features.device_id === params.device));
        }

        if (!device) return false;
    }

    // validate requested network
    if (params.hasOwnProperty('network')) {
        const { config } = getState().localStorage;
        const coin = config.coins.find(c => c.network === params.network);
        if (!coin) return false;
        if (!params.account) return false;
    }

    // validate requested account
    // TODO: only if discovery on this network is completed
    // if (params.hasOwnProperty('account')) {

    // }
    return true;
};

/*
* Composing url string from given RouterLocationState object
* Filters unrecognized fields and sorting in correct order
*/
export const paramsToPath = (params: RouterLocationState): PayloadAction<?string> => (): ?string => {
    // get patterns (fields) from routes and sort them by complexity
    const patterns: Array<Array<string>> = routes.map(r => r.fields).sort((a, b) => (a.length > b.length ? -1 : 1));

    // find pattern
    const keys: Array<string> = Object.keys(params);
    let patternToUse: ?Array<string>;
    let i: number;
    for (i = 0; i < patterns.length; i++) {
        const pattern = patterns[i];
        const match: Array<string> = keys.filter(key => pattern.indexOf(key) >= 0);
        if (match.length === pattern.length) {
            patternToUse = pattern;
            break;
        }
    }

    // pattern not found, redirect back
    if (!patternToUse) return null;

    // compose url string from pattern
    let url: string = '';
    patternToUse.forEach((field) => {
        if (field === params[field]) {
            // standalone (odd) fields
            url += `/${field}`;
        } else {
            url += `/${field}/${params[field]}`;
            if (field === 'device') {
                if (params.hasOwnProperty('deviceInstance')) {
                    url += `:${params.deviceInstance}`;
                }
            }
        }
    });
    return url;
};

export const getValidUrl = (action: RouterAction): PayloadAction<string> => (dispatch: Dispatch, getState: GetState): string => {
    const { location } = getState().router;

    // redirect to landing page (loading screen)
    // and wait until application is ready
    if (!location) return '/';

    const requestedUrl = action.payload.pathname;
    // Corner case: LOCATION_CHANGE was called but pathname didn't changed (redirect action from RouterService)
    if (requestedUrl === location.pathname) return requestedUrl;

    // Modal is opened
    // redirect to previous url
    if (getState().modal.opened) {
        // Corner case: modal is opened and currentParams are still valid
        // example 1 (valid blocking): url changed while passphrase modal opened but device is still connected (we want user to finish this action)
        // example 2 (invalid blocking): url changes while passphrase modal opened because device disconnect
        const currentParams = dispatch(pathToParams(location.pathname));
        const currentParamsAreValid = dispatch(paramsValidation(currentParams));
        if (currentParamsAreValid) { return location.pathname; }
    }

    // there are no connected devices or application isn't ready or initialization error occurred
    // redirect to landing page
    const shouldBeLandingPage = getState().devices.length < 1 || !getState().wallet.ready || getState().connect.error !== null;
    const landingPageUrl = dispatch(isLandingPageUrl(requestedUrl));
    if (shouldBeLandingPage) {
        return !landingPageUrl ? '/' : requestedUrl;
    }

    // Disallow displaying landing page
    // redirect to previous url
    if (!shouldBeLandingPage && landingPageUrl) {
        return location.pathname;
    }

    // Regular url change during application live cycle
    const requestedParams = dispatch(pathToParams(requestedUrl));
    const requestedParamsAreValid: boolean = dispatch(paramsValidation(requestedParams));

    // Requested params are not valid
    // Neither device or network doesn't exists
    if (!requestedParamsAreValid) {
        return location.pathname;
    }

    // Compose valid url from requested params
    const composedUrl = dispatch(paramsToPath(requestedParams));
    return composedUrl || location.pathname;
};


/*
* Utility used in "selectDevice" and "selectFirstAvailableDevice"
* sorting device array by "ts" (timestamp) field
*/
const sortDevices = (devices: Array<TrezorDevice>): Array<TrezorDevice> => devices.sort((a, b) => {
    if (!a.ts || !b.ts) {
        return -1;
    }
    return a.ts > b.ts ? -1 : 1;
});

/*
* Compose url from given device object and redirect
*/
export const selectDevice = (device: TrezorDevice | Device): ThunkAction => (dispatch: Dispatch, getState: GetState): void => {
    let url: ?string;
    if (!device.features) {
        url = `/device/${device.path}/${device.type === 'unreadable' ? 'unreadable' : 'acquire'}`;
    } else if (device.features.bootloader_mode) {
        url = `/device/${device.path}/bootloader`;
    } else if (!device.features.initialized) {
        url = `/device/${device.features.device_id}/initialize`;
    } else if (typeof device.instance === 'number') {
        url = `/device/${device.features.device_id}:${device.instance}`;
    } else {
        url = `/device/${device.features.device_id}`;
        // make sure that device is not TrezorDevice type
        if (!device.hasOwnProperty('ts')) {
            // it is device from trezor-connect triggered by DEVICE.CONNECT event
            // need to lookup if there are unavailable instances
            const available: Array<TrezorDevice> = getState().devices.filter(d => d.path === device.path);
            const latest: Array<TrezorDevice> = sortDevices(available);
            if (latest.length > 0 && latest[0].instance) {
                url += `:${latest[0].instance}`;
            }
        }
    }

    const currentParams: RouterLocationState = getState().router.location.state;
    const requestedParams = dispatch(pathToParams(url));
    if (currentParams.device !== requestedParams.device || currentParams.deviceInstance !== requestedParams.deviceInstance) {
        dispatch(goto(url));
    }
};

/*
* Try to find first available device using order:
* 1. First unacquired
* 2. First connected
* 3. Saved with latest timestamp
* OR redirect to landing page
*/
export const selectFirstAvailableDevice = (): ThunkAction => (dispatch: Dispatch, getState: GetState): void => {
    const { devices } = getState();
    if (devices.length > 0) {
        const unacquired = devices.find(d => !d.features);
        if (unacquired) {
            dispatch(selectDevice(unacquired));
        } else {
            const latest: Array<TrezorDevice> = sortDevices(devices);
            const firstConnected: ?TrezorDevice = latest.find(d => d.connected);
            dispatch(selectDevice(firstConnected || latest[0]));
        }
    } else {
        dispatch(gotoLandingPage());
    }
};

/*
* Internal method. redirect to given url
*/
const goto = (url: string): ThunkAction => (dispatch: Dispatch, getState: GetState): void => {
    if (getState().router.location.pathname !== url) {
        dispatch(push(url));
    }
};

/*
* Check if requested OR current url is landing page
*/
export const isLandingPageUrl = ($url?: string): PayloadAction<boolean> => (dispatch: Dispatch, getState: GetState): boolean => {
    let url: ?string = $url;
    if (typeof url !== 'string') {
        url = getState().router.location.pathname;
    }
    // TODO: add more landing page cases/urls to config.json (like /tools etc)
    return (url === '/' || url === '/bridge');
};

/*
* Try to redirect to landing page
*/
export const gotoLandingPage = (): ThunkAction => (dispatch: Dispatch): void => {
    const isLandingPage = dispatch(isLandingPageUrl());
    if (!isLandingPage) {
        dispatch(goto('/'));
    }
};

/*
* Go to given device settings page
*/
export const gotoDeviceSettings = (device: TrezorDevice): ThunkAction => (dispatch: Dispatch): void => {
    if (device.features) {
        const devUrl: string = `${device.features.device_id}${device.instance ? `:${device.instance}` : ''}`;
        dispatch(goto(`/device/${devUrl}/settings`));
    }
};

/*
* Try to redirect to initial url
*/
export const setInitialUrl = (): PayloadAction<boolean> => (dispatch: Dispatch, getState: GetState): boolean => {
    const { initialPathname } = getState().wallet;
    if (typeof initialPathname === 'string' && !dispatch(isLandingPageUrl(initialPathname))) {
        const valid = dispatch(getValidUrl({
            type: LOCATION_CHANGE,
            payload: {
                pathname: initialPathname,
                hash: '',
                search: '',
                state: {},
            },
        }));
        if (valid === initialPathname) {
            dispatch(goto(valid));
            return true;
        }
    }
    return false;
};