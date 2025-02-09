'use strict';

import constants from './constants';
import containers from './containers';
import storage from './storage';
import * as npmCompareVersions from 'compare-versions';

const addonUrlPrefix = browser.extension.getURL('');

const tagsToReplace = {
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
    '&': '&amp;',
};

const {version} = browser.runtime.getManifest();

function getErrorLogs() {
    let logs = [];

    try {
        logs = JSON.parse(window.localStorage.errorLogs);
    } catch (e) {}

    return logs || [];
}

function errorEventMessage(message, data = null, showNotification = true) {
    return JSON.stringify({
        message,
        data,
        showNotification,
    });
}

function errorEventHandler(event) {
    event.preventDefault && event.preventDefault();
    event.stopImmediatePropagation && event.stopImmediatePropagation();

    if (!event.error) {
        event.error = event;
    }

    let data = null;

    try {
        data = JSON.parse(event.error.message);

        if (Number.isFinite(data)) {
            throw Error;
        }
    } catch (e) {
        data = event.error;
    }

    let error = {
        version,
        date: (new Date).toLocaleString(),
        message: data.message,
        data: data.data,
        lineNumber: event.error.lineNumber,
        stack: event.error.stack.split(addonUrlPrefix).join('').split('@').map(str => str.trim().replace('\n', ' -> ')),
    };

    let logs = getErrorLogs();

    logs.unshift(error);

    window.localStorage.errorLogs = JSON.stringify(logs.slice(0, 30));

    if (false !== data.showNotification) {
        notify(browser.i18n.getMessage('whatsWrongMessage'))
            .then(() => browser.runtime.openOptionsPage(), undefined, undefined, false);
    }

    console.error(`[STG] ${event.error.name}: ${error.message}`, error);
}

async function getInfo() {
    return {
        version: browser.runtime.getManifest().version,
        upTime: Date.now() - browser.extension.getBackgroundPage().BG.startTime + 'ms',
        browserInfo: await browser.runtime.getBrowserInfo(),
        platformInfo: await browser.runtime.getPlatformInfo(),
        permissions: {
            bookmarks: await browser.permissions.contains(constants.PERMISSIONS.BOOKMARKS),
        },
        options: await storage.get(constants.allOptionsKeys),
    };
}

function keyId({id}) {
    return id;
}

function unixNow() {
    return Math.round(Date.now() / 1000);
}

function type(obj) {
    return Object.prototype.toString.call(obj).replace(/(^\[.+\ |\]$)/g, '').toLowerCase();
}

function getCircularReplacer() {
    const seen = new WeakSet();

    return (key, value) => {
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
                return;
            }

            seen.add(value);
        }

        return value;
    };
}

function clone(obj = null) {
    return JSON.parse(JSON.stringify(obj, getCircularReplacer()));
}

function cloneTab({id, title, discarded, url, active, hidden, sharingState, windowId, cookieStoreId}) {
    return {id, title, discarded, url, active, hidden, sharingState: {...sharingState}, windowId, cookieStoreId};
}

function format(str, ...args) {
    if (!str) {
        return '';
    }

    if (1 === args.length && ['object', 'error'].includes(type(args[0]))) {
        args = args[0];
    }

    return str.replace(/{{(.+?)}}/g, function(match, key) {
        let val = key
            .split('.')
            .reduce((accum, key) => (accum && accum[key]), args);

        if (val || val === '' || val === 0) {
            return val;
        } else if (undefined === val) {
            return '';
            // return key;
        }

        return match;
    });
}

function formatBytes(bytes, decimals = 2) {
    if (0 === bytes) {
        return '0 Bytes';
    }

    let k = 1024,
        sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
        i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

function objectReplaceKeyValue(obj) {
    let result = {};

    Object.keys(obj).forEach(function(key) {
        result[obj[key]] = key;
    });

    return result;
}

function safeHtml(html) {
    let regExp = new RegExp('[' + Object.keys(tagsToReplace).join('') + ']', 'g');
    return (html || '').replace(regExp, tag => tagsToReplace[tag] || tag);
}

function unSafeHtml(html) {
    let replasedTags = objectReplaceKeyValue(tagsToReplace),
        regExp = new RegExp('(' + Object.keys(replasedTags).join('|') + ')', 'g');
    return (html || '').replace(regExp, tag => replasedTags[tag] || tag);
}

function b64EncodeUnicode(str) {
    // first we use encodeURIComponent to get percent-encoded UTF-8,
    // then we convert the percent encodings into raw bytes which
    // can be fed into btoa.
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
        function toSolidBytes(match, p1) {
            return String.fromCharCode('0x' + p1);
        }));
}

function b64DecodeUnicode(str) {
    // Going backwards: from bytestream, to percent-encoding, to original string.
    return decodeURIComponent(atob(str).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
}

function sliceText(text, length = 50) {
    return (text && text.length > length) ? (text.slice(0, length - 3) + '...') : (text || '');
}

function notify(message, timer = 20000, id = null, catchReject = true, iconUrl = null) {
    const {BG} = browser.extension.getBackgroundPage();

    if (id) {
        BG.browser.notifications.clear(id);
    } else {
        id = String(Date.now());
    }

    // https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/notifications/NotificationOptions
    // Only 'type', 'iconUrl', 'title', and 'message' are supported.
    BG.browser.notifications.create(id, {
        type: 'basic',
        iconUrl: iconUrl || '/icons/icon.svg',
        title: browser.i18n.getMessage('extensionName'),
        message: String(message),
    });

    let promise = new Promise(function(resolve, reject) {
        let rejectTimer = null;

        let listener = function() {
            BG.browser.notifications.onClicked.removeListener(listener);
            clearTimeout(rejectTimer);
            resolve(id);
        };

        rejectTimer = setTimeout(function() {
            BG.browser.notifications.onClicked.removeListener(listener);
            BG.browser.notifications.clear(id);
            reject(id);
        }, timer);

        browser.notifications.onClicked.addListener(listener);
    });

    return catchReject ? promise.catch(function() {}) : promise;
}

function isAllowSender(request, sender) {
    if (sender.id !== browser.runtime.id || !request || request.isExternalMessage) {
        return false;
    }

    return true;
}

function isAllowExternalRequestAndSender(request, sender, extensionRules = {}) {
    let extension = constants.EXTENSIONS_WHITE_LIST[sender.id];

    if (!extension) {
        return false;
    }

    Object.assign(extensionRules, extension);

    if (!request || 'object' !== type(request)) {
        extensionRules.error = 'request is wrong';
        return false;
    }

    return extension.getActions.includes(request.action);
}

function getSupportedExternalExtensionName(extId) {
    return constants.EXTENSIONS_WHITE_LIST[extId] ? constants.EXTENSIONS_WHITE_LIST[extId].title : 'Unknown';
}

function normalizeFavIcon(favIconUrl) {
    if (favIconUrl) {
        return favIconUrl.startsWith('chrome://mozapps/skin/') ? '/icons/tab.svg' : favIconUrl;
    }

    return '/icons/tab.svg';
}

function isWindowAllow(win) {
    return browser.windows.WindowType.NORMAL === win.type;
}

const createTabUrlRegexp = /^((https?|ftp|moz-extension):|about:blank)/,
    emptyUrlsArray = ['about:blank', 'about:newtab', 'about:home'];

function isUrlEmpty(url) {
    return emptyUrlsArray.includes(url);
}

function isUrlAllowToCreate(url, falseIfEmpty = true) {
    let result = createTabUrlRegexp.test(url);

    if (result && falseIfEmpty && isUrlEmpty(url)) {
        return false;
    }

    return result;
}

function normalizeUrl(url) {
    if (url && url.startsWith('moz-extension')) {
        let urlObj = new URL(url),
            urlStr = urlObj.searchParams.get('url') || urlObj.searchParams.get('u');

        return urlStr ? normalizeUrl(decodeURIComponent(urlStr)) : url;
    }

    return url || '';
}

function isTabPinned(tab) {
    return tab.pinned;
}

function isTabNotPinned(tab) {
    return !isTabPinned(tab);
}

function isTabCanBeHidden(tab) {
    return !isTabPinned(tab) && tab.sharingState && !tab.sharingState.screen && !tab.sharingState.camera && !tab.sharingState.microphone;
}

function isTabCanNotBeHidden(tab) {
    return !isTabCanBeHidden(tab);
}

function isTabLoaded({status}) {
    return browser.tabs.TabStatus.COMPLETE === status;
}

function isTabLoading({status}) {
    return browser.tabs.TabStatus.LOADING === status;
}

function createGroupTitle(title, groupId) {
    return String(title || browser.i18n.getMessage('newGroupTitle', groupId));
}

function getGroupLastActiveTab({tabs}) {
    return tabs.find(tab => tab.active) || tabs.slice().sort(sortBy('lastAccessed')).pop();
}

function getGroupTitle({id, title, tabs, newTabContainer}, args = '') {
    const {BG} = browser.extension.getBackgroundPage();

    let withActiveGroup = args.includes('withActiveGroup'),
        withCountTabs = args.includes('withCountTabs'),
        withActiveTab = args.includes('withActiveTab'),
        withContainer = args.includes('withContainer'),
        withTabs = args.includes('withTabs');

    if (withActiveGroup && BG.cache.getWindowId(id)) {
        title = constants.ACTIVE_SYMBOL + ' ' + title;
    }

    if (withContainer && newTabContainer) {
        title = '[' + BG.containers.get(newTabContainer, 'name') + '] ' + title;
    }

    tabs = tabs.slice();

    if (withCountTabs) {
        title += ' (' + groupTabsCountMessage(tabs) + ')';
    }

    if (withActiveTab && tabs.length) {
        let activeTab = getGroupLastActiveTab({tabs});

        if (activeTab) {
            title += ' ' + (activeTab.discarded ? constants.DISCARDED_SYMBOL : constants.ACTIVE_SYMBOL) + ' ' + getTabTitle(activeTab);
        }
    }

    if (withTabs && tabs.length) {
        title += ':\n' + tabs
            .slice(0, 30)
            .map(tab => getTabTitle(tab, false, 70, true))
            .join('\n');

        if (tabs.length > 30) {
            title += '\n...';
        }
    }

    if (window.localStorage.enableDebug) {
        title = `#${id} ${title}`;
    }

    return title;
}

function getTabTitle({id, index, title, url, discarded}, withUrl = false, sliceLength = 0, withTabActive = false) {
    title = title || url || 'about:blank';

    if (withUrl && url && title !== url) {
        title += '\n' + url;
    }

    if (withTabActive && !discarded) {
        title = constants.ACTIVE_SYMBOL + ' ' + title;
    }

    if (window.localStorage.enableDebug) {
        title = `#${id}:${index} ${title}`;
    }

    return sliceLength ? sliceText(title, sliceLength) : title;
}

function groupTabsCountMessage(tabs, withActiveTabs) {
    const {BG} = browser.extension.getBackgroundPage();

    let {showExtendGroupsPopupWithActiveTabs} = BG.getOptions();

    if (withActiveTabs || showExtendGroupsPopupWithActiveTabs) {
        let activeTabs = tabs.filter(tab => !tab.discarded).length;
        return browser.i18n.getMessage('groupTabsCountActive', [activeTabs, tabs.length]);
    } else {
        return browser.i18n.getMessage('groupTabsCount', tabs.length);
    }
}

function getNextIndex(index, length, textPosition = 'next') {
    if (!length || 0 > length) {
        return false;
    }

    if (1 === length) {
        return 0;
    }

    if ('next' === textPosition) {
        return (index + 1) % length;
    } else if ('prev' === textPosition) {
        return 0 === index ? length - 1 : index - 1;
    } else {
        throw Error(`invalid textPosition: ${textPosition}`);
    }
}

function toCamelCase(str) {
    return str.replace(/^([A-Z])|[\s_-](\w)/g, function(match, p1, p2) {
        return p2 ? p2.toUpperCase() : p1.toLowerCase();
    });
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function sortBy(key, numeric, reverse) {
    return function(objA, objB) {
        return reverse ? compareStrings(objB[key], objA[key], numeric) : compareStrings(objA[key], objB[key], numeric);
    };
}

function scrollTo(node) {
    if ('string' === type(node)) {
        node = document.querySelector(node);
    }

    node && node.scrollIntoView({
        block: 'center',
        behavior: 'smooth',
    });
}

// -1 : a < b
// 0 : a === b
// 1 : a > b
function compareStrings(a, b, numeric = true) {
    return String(a).localeCompare(String(b), [], {
        numeric: numeric,
    });
}

// -1 : a < b
// 0 : a === b
// 1 : a > b
function compareVersions(a, b) {
    return npmCompareVersions(String(a), String(b));
}

function isElementVisible(element) {
    let rect = element.getBoundingClientRect();

    // Only completely visible elements return true:
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
    // Partially visible elements return true:
    // let isVisible = elemTop < window.innerHeight && elemBottom >= 0;
    // return isVisible;
}

function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}

function randomColor() {
    return 'hsla(' + getRandomInt(0, 360) + ', 100%, 50%, 1)';
}

function safeColor(color) {
    let div = document.createElement('div');
    div.style.backgroundColor = color;
    return div.style.backgroundColor;
}

function getGroupIconUrl(group = { iconViewType: constants.DEFAULT_OPTIONS.defaultGroupIconViewType }, keyInObj = null) {
    let result = null;

    if (group.iconUrl) {
        result = group.iconUrl;
    } else {
        if (!group.iconColor) {
            group.iconColor = 'transparent';
        }

        let stroke = 'transparent' === group.iconColor ? 'stroke="#606060" stroke-width="1"' : '';

        let icons = {
            'main-squares': `
                <svg width="128" height="128" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg">
                    <g fill="context-fill" fill-opacity="context-fill-opacity">
                        <rect height="32" width="32" />
                        <rect height="32" width="32" x="48" />
                        <rect height="32" width="32" x="96" y="48" />
                        <rect height="32" width="32" y="48" />
                        <rect height="32" width="32" x="48" y="48" />
                        <rect height="32" width="32" x="96" />
                        <rect height="32" width="32" y="96" />
                        <rect height="32" width="32" x="48" y="96" />
                        <rect height="32" width="32" x="96" y="96" />
                        <path transform="rotate(-90, 73, 71)" fill="${group.iconColor}" d="m16.000351,126.001527l0,-110.000003l108.999285,110.000003l-108.999285,0z"/>
                    </g>
                </svg>
            `,
            circle: `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                    <circle fill="${group.iconColor}" cx="8" cy="8" r="8" ${stroke} />
                </svg>
            `,
            squares: `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                    <g fill="context-fill" fill-opacity="context-fill-opacity">
                        <rect x="1" y="1" width="6" height="6" rx="1" ry="1"></rect>
                        <rect x="9" y="1" width="6" height="6" rx="1" ry="1"></rect>
                        <rect x="1" y="9" width="6" height="6" rx="1" ry="1"></rect>
                        <rect x="9" y="9" width="6" height="6" rx="1" ry="1" fill="${group.iconColor}"></rect>
                    </g>
                </svg>
            `,
            'old-tab-groups': `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                    <g fill="context-fill" fill-opacity="context-fill-opacity">
                        <rect width="9" height="6" x="1" y="1" rx="1"></rect>
                        <rect width="4" height="6" x="11" y="1" rx="1"></rect>
                        <rect width="5" height="7" x="1" y="8" rx="1"></rect>
                        <rect width="8" height="7" x="7" y="8" rx="1" fill="${group.iconColor}"></rect>
                    </g>
                </svg>
            `,
        };

        result = convertSvgToUrl(icons[group.iconViewType]);
    }

    if (keyInObj) {
        return {
            [keyInObj]: result,
        };
    }

    return result;
}

function convertSvgToUrl(svg) {
    return 'data:image/svg+xml;base64,' + b64EncodeUnicode(svg);
}

function resizeImage(img, height, width, useTransparency = true, ...canvasParams) { // img: new Image()
    let canvas = document.createElement('canvas'),
        context = canvas.getContext('2d');

    if (!useTransparency) {
        canvas.mozOpaque = true;
    }

    canvas.width = width;
    canvas.height = height;

    context.drawImage(img, 0, 0, width, height);

    return isCanvasBlank(canvas, useTransparency, ...canvasParams) ? null : canvas.toDataURL(...canvasParams);
}

function isCanvasBlank(canvas, useTransparency, ...canvasParams) {
    let blank = document.createElement('canvas'),
        canvasDataUrl = canvas.toDataURL(...canvasParams);

    if (!useTransparency) {
        blank.mozOpaque = true;
    }

    blank.width = canvas.width;
    blank.height = canvas.height;

    let isEmpty = canvasDataUrl === blank.toDataURL(...canvasParams);

    if (!isEmpty) {
        let blankContext = blank.getContext('2d');

        blankContext.fillStyle = 'rgb(255, 255, 255)';
        blankContext.fillRect(0, 0, blank.width, blank.height);

        isEmpty = canvasDataUrl === blank.toDataURL(...canvasParams);
    }

    return isEmpty;
}

// needle need to be "LowerCased"
function mySearchFunc(needle, haystack, extendedSearch = false) {
    haystack = 'string' === typeof haystack ? haystack.toLowerCase() : '';

    if (!extendedSearch) {
        return haystack.includes(needle);
    }

    let lastFindIndex = -1;

    return needle
        .split('')
        .every(function(char) {
            if (' ' === char) {
                return true;
            }

            lastFindIndex = haystack.indexOf(char, lastFindIndex + 1);
            return -1 !== lastFindIndex;
        });
}

function onlyUniqueFilter(value, index, self) {
    return self.indexOf(value) === index;
}

function extractKeys(obj, keys, useClone = false) {
    let newObj = {};

    keys.forEach(key => newObj[key] = (useClone ? clone(obj[key]) : obj[key]));

    return newObj;
}

function wait(ms = 200) {
    return new Promise(resolve => setTimeout(resolve, ms, ms));
}

async function waitDownload(id, maxWaitSec = 10) {
    let downloadObj = null;

    for (let i = 0; i < maxWaitSec * 5; i++) {
        [downloadObj] = await browser.downloads.search({id});

        if (downloadObj && browser.downloads.State.IN_PROGRESS !== downloadObj.state) {
            break;
        }

        await wait(200);
    }

    return downloadObj ? downloadObj.state : null;
}

export default {
    errorEventMessage,
    errorEventHandler,
    getErrorLogs,

    getInfo,

    keyId,
    unixNow,
    type,
    clone,
    cloneTab,
    format,
    formatBytes,
    extractKeys,
    onlyUniqueFilter,

    safeHtml,
    unSafeHtml,

    sliceText,

    notify,

    normalizeFavIcon,

    getSupportedExternalExtensionName,

    isAllowSender,
    isAllowExternalRequestAndSender,
    isWindowAllow,
    isUrlEmpty,
    isUrlAllowToCreate,
    normalizeUrl,
    isTabPinned,
    isTabNotPinned,
    isTabCanBeHidden,
    isTabCanNotBeHidden,
    isTabLoaded,
    isTabLoading,

    createGroupTitle,
    getGroupLastActiveTab,
    getGroupTitle,
    getTabTitle,
    groupTabsCountMessage,

    getNextIndex,
    toCamelCase,
    capitalize,
    sortBy,
    scrollTo,
    compareStrings,
    compareVersions,

    isElementVisible,
    getGroupIconUrl,

    safeColor,
    getRandomInt,
    randomColor,

    resizeImage,

    mySearchFunc,

    wait,
    waitDownload,
};
