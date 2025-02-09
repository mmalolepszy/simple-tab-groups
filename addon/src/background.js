'use strict';

import constants from './js/constants';
import containers from './js/containers';
import utils from './js/utils';
import storage from './js/storage';
import file from './js/file';
import cache from './js/cache';
import Groups from './js/groups';
import Tabs from './js/tabs';
import Windows from './js/windows';

window.IS_PRODUCTION = IS_PRODUCTION;
console.restart();

const addonUrlPrefix = browser.extension.getURL('');
const manageTabsPageUrl = browser.extension.getURL(constants.MANAGE_TABS_URL);
const manifest = browser.runtime.getManifest();
const noop = function() {};

let options = {},
    reCreateTabsOnRemoveWindow = [],
    menuIds = [],
    excludeTabsIds = [],

    groupsHistory = (function() {
        let index = -1,
            groupIds = [];

        return {
            next(groups) {
                groupIds = groupIds.filter(groupId => groups.some(group => group.id === groupId));

                if (!groupIds[index + 1]) {
                    return;
                }

                return groupIds[++index];
            },
            prev(groups) {
                groupIds = groupIds.filter(groupId => groups.some(group => group.id === groupId));

                if (!groupIds[index - 1]) {
                    return;
                }

                return groupIds[--index];
            },
            add(groupId) {
                index = groupIds.push(groupId) - 1;
            },
        };
    })();

window.addEventListener('error', utils.errorEventHandler);

async function createTabsSafe(tabs, hideTabs, withRemoveEvents = true) {
    if (withRemoveEvents) {
        removeEvents();
    }

    let result = await Promise.all(tabs.map(function(tab) {
        delete tab.index;
        return Tabs.create(tab);
    }));

    if (hideTabs) {
        let notPinnedTabs = result.filter(tab => !tab.pinned);

        if (notPinnedTabs.length) {
            await browser.tabs.hide(notPinnedTabs.map(utils.keyId));
            notPinnedTabs.forEach(tab => tab.hidden = true);
        }
    }

    if (withRemoveEvents) {
        addEvents();
    }

    return result;
}

function sendMessage(data) {
    if (!window.BG.inited) {
        console.warn('addon not yet loaded');
        return;
    }

    console.info('BG event:', data.action, data);

    browser.runtime.sendMessage(data).catch(noop);
}

function sendExternalMessage(data) {
    if (!window.BG.inited) {
        console.warn('addon not yet loaded');
        return;
    }

    console.info('BG event external:', data.action, data);

    Object.keys(constants.EXTENSIONS_WHITE_LIST)
        .forEach(function(exId) {
            if (constants.EXTENSIONS_WHITE_LIST[exId].postActions.includes(data.action)) {
                data.isExternalMessage = true;
                browser.runtime.sendMessage(exId, data).catch(noop);
            }
        });
}

let _loadingGroupInWindow = {}; // windowId: true;
async function applyGroup(windowId, groupId, activeTabId, applyFromHistory = false) {
    windowId = windowId || await Windows.getLastFocusedNormalWindow();

    if (_loadingGroupInWindow[windowId]) {
        return false;
    }

    console.log('applyGroup args groupId: %s, windowId: %s, activeTab: %s', groupId, windowId, activeTabId);

    _loadingGroupInWindow[windowId] = true;

    let groupWindowId = cache.getWindowId(groupId);

    console.time('load-group-' + groupId);

    let result = null;

    try {
        if (groupWindowId) {
            if (activeTabId) {
                Tabs.setActive(activeTabId);
            }

            Windows.setFocus(groupWindowId);
        } else {
            // magic

            let [groupToShow, groups] = await Groups.load(groupId, true),
                oldGroupId = cache.getWindowGroup(windowId),
                groupToHide = groups.find(gr => gr.id === oldGroupId);

            if (!groupToShow) {
                throw Error(utils.errorEventMessage('applyGroup: groupToShow not found', {groupId, activeTabId}));
            }

            if (groupToHide && groupToHide.tabs.some(utils.isTabCanNotBeHidden)) {
                utils.notify(browser.i18n.getMessage('notPossibleSwitchGroupBecauseSomeTabShareMicrophoneOrCamera'));
                throw '';
            }

            if (!applyFromHistory) {
                groupsHistory.add(groupId);
            }

            loadingBrowserAction(true, windowId);

            removeEvents();

            // show tabs
            if (groupToShow.tabs.length) {
                let tabIds = groupToShow.tabs.map(utils.keyId);

                if (!groupToShow.tabs.every(tab => tab.windowId === windowId)) {
                    groupToShow.tabs = await Tabs.moveNative(groupToShow.tabs, {
                        index: -1,
                        windowId: windowId,
                    });
                }

                await browser.tabs.show(tabIds);

                if (groupToShow.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                    Tabs.setMute(groupToShow.tabs, false);
                }

                // set active tab
                let pinnedTabs = await Tabs.get(windowId, true);

                if (!pinnedTabs.some(tab => tab.active) || activeTabId) {
                    await Tabs.setActive(activeTabId, groupToShow.tabs);
                }
            }

            await cache.setWindowGroup(windowId, groupToShow.id);

            // hide tabs
            if (groupToHide && groupToHide.tabs.length) {
                let tabsIdsToRemove = [];

                groupToHide.tabs = groupToHide.tabs.filter(function(tab) {
                    if (tab.url === manageTabsPageUrl) {
                        tabsIdsToRemove.push(tab.id);
                        return false;
                    }

                    return true;
                });

                if (groupToHide.tabs.length) {
                    if (groupToHide.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                        Tabs.setMute(groupToHide.tabs, true);
                    }

                    if (!groupToShow.tabs.length) {
                        await Tabs.createTempActiveTab(windowId, false);
                    }

                    let tabIds = groupToHide.tabs.map(utils.keyId);

                    let hideTabsResult = await browser.tabs.hide(tabIds);

                    console.assert(hideTabsResult.length === tabIds.length, 'some tabs not hide');

                    if (options.discardTabsAfterHide && !groupToHide.dontDiscardTabsAfterHideThisGroup) {
                        Tabs.discard(tabIds);
                        tabIds.forEach(function(tabId) {
                            sendMessage({
                                action: 'tab-updated',
                                tab: {
                                    id: tabId,
                                    discarded: true,
                                },
                            });
                        });
                    }
                }

                if (tabsIdsToRemove.length) {
                    Tabs.remove(tabsIdsToRemove);
                    tabsIdsToRemove.forEach(tabId => onRemovedTab(tabId, {}));
                }
            }

            // set group id for tabs which may has opened without groupId (new window without group, etc...)
            Tabs.get(windowId)
                .then(function(tabs) {
                    tabs.forEach(function(tab) {
                        if (tab.session.groupId !== groupToShow.id) {
                            tab.session.groupId = groupToShow.id;
                            cache.setTabGroup(tab.id, groupToShow.id);
                        }
                    });

                    sendMessage({
                        action: 'group-updated',
                        group: {
                            id: groupToShow.id,
                            tabs,
                        },
                    });
                });

            updateMoveTabMenus(windowId);

            updateBrowserActionData(groupToShow.id);

            addEvents();
        }

        sendMessage({
            action: 'group-loaded',
            groupId,
            windowId,
        });

        result = true;
    } catch (e) {
        result = false;

        if (e) {
            console.error('🛑 STOP applyGroup with error', e);

            updateBrowserActionData(null, windowId);

            if (!groupWindowId) {
                removeEvents();
                addEvents();
            }

            utils.errorEventHandler(e);
        }
    }

    delete _loadingGroupInWindow[windowId];

    console.timeEnd('load-group-' + groupId);

    return result;
}

async function applyGroupByPosition(textPosition, groups, currentGroupId) {
    if (1 >= groups.length) {
        return false;
    }

    let currentGroupIndex = groups.findIndex(group => group.id === currentGroupId);

    if (-1 === currentGroupIndex) {
        currentGroupIndex = 'next' === textPosition ? (groups.length - 1) : 0;
    }

    let nextGroupIndex = utils.getNextIndex(currentGroupIndex, groups.length, textPosition);

    return applyGroup(undefined, groups[nextGroupIndex].id);
}


async function applyGroupByHistory(textPosition, groups) {
    if (1 >= groups.length) {
        return false;
    }

    let nextGroupId = 'next' === textPosition ? groupsHistory.next(groups) : groupsHistory.prev(groups);

    if (!nextGroupId) {
        return false;
    }

    return applyGroup(undefined, nextGroupId, undefined, true);
}

async function onActivatedTab({ previousTabId, tabId, windowId }) {
    console.log('onActivatedTab', { previousTabId, tabId, windowId });

    if (cache.getTabSession(tabId, 'groupId')) {
        sendMessage({
            action: 'tab-updated',
            tab: {
                id: tabId,
                active: true,
            },
        });

        Tabs.updateThumbnail(tabId);
    }

    if (previousTabId && cache.getTabSession(previousTabId, 'groupId')) {
        sendMessage({
            action: 'tab-updated',
            tab: {
                id: previousTabId,
                active: false,
            },
        });
    }
}

function _isCatchedUrl(url, catchTabRules) {
    if (!catchTabRules) {
        return false;
    }

    return catchTabRules
        .trim()
        .split(/\s*\n\s*/)
        .map(regExpStr => regExpStr.trim())
        .filter(Boolean)
        .some(function(regExpStr) {
            try {
                return new RegExp(regExpStr).test(url);
            } catch (e) {};
        });
}

function _getCatchedGroupForTab(groups, tab, checkTabAsNew = false) {
    return groups.find(function(group) {
        if (group.catchTabContainers.includes(tab.cookieStoreId)) {
            return true;
        }

        if (_isCatchedUrl(tab.url, group.catchTabRules)) {
            return true;
        }

        if (checkTabAsNew && 'about:blank' === tab.url && utils.isTabLoaded(tab) && _isCatchedUrl(tab.title, group.catchTabRules)) {
            return true;
        }
    });
}

async function onCreatedTab(tab) {
    console.log('onCreatedTab', tab);

    cache.setTab(tab);

    if (utils.isTabPinned(tab)) {
        return;
    }

    let groupId = cache.getWindowGroup(tab.windowId);

    cache.setTabGroup(tab.id, groupId);

    if (groupId) {
        updateGroupTabsEvent(groupId);
    }
}

function addExcludeTabsIds(tabIds) {
    excludeTabsIds.push(...tabIds);
}

function removeExcludeTabsIds(tabIds) {
    excludeTabsIds = excludeTabsIds.filter(tabId => !tabIds.includes(tabId));
}

function onUpdatedTab(tabId, changeInfo, tab) {
    let excludeTab = excludeTabsIds.includes(tab.id);

    console.log('onUpdatedTab %s tabId: %s, changeInfo:', (excludeTab ? '🛑' : ''), tab.id, changeInfo);

    if (excludeTab) {
        return;
    }

    if (utils.isTabPinned(tab) && undefined === changeInfo.pinned) {
        console.log('onUpdatedTab 🛑 tab is pinned tabId: %s, changeInfo:', tab.id, changeInfo);
        return;
    }

    if (!cache.hasTab(tab.id)) {
        console.log('onUpdatedTab 🛑 tab not yet created tabId: %s, changeInfo:', tab.id);
        return;
    }

    cache.setTab(tab);

    if (undefined === changeInfo.discarded) { // discarded not work when tab loading
        changeInfo.discarded = false;
    }

    let tabGroupId = cache.getTabSession(tab.id, 'groupId'),
        winGroupId = cache.getWindowGroup(tab.windowId);

    if (changeInfo.favIconUrl && (tabGroupId || winGroupId)) {
        changeInfo.favIconUrl = utils.normalizeFavIcon(changeInfo.favIconUrl);
        cache.setTabFavIcon(tab.id, changeInfo.favIconUrl);
    }

    if ('pinned' in changeInfo || 'hidden' in changeInfo) {
        if (changeInfo.pinned || changeInfo.hidden) {
            if (tabGroupId) {
                cache.removeTabGroup(tab.id);

                sendMessage({
                    action: 'tab-removed',
                    tabId: tab.id,
                });
            }
        } else {

            if (false === changeInfo.pinned) {
                cache.setTabGroup(tab.id, winGroupId);
            } else if (false === changeInfo.hidden) {
                if (tabGroupId) {
                    applyGroup(tab.windowId, tabGroupId, tab.id);
                    return;
                } else {
                    cache.setTabGroup(tab.id, winGroupId);
                }
            }

            if (winGroupId) {
                tab.session = cache.getTabSession(tab.id);

                sendMessage({
                    action: 'tab-added',
                    tab: tab,
                });
            }
        }

        return;
    }

    if (tabGroupId || winGroupId) {
        if (utils.isTabLoaded(changeInfo)) {
            Tabs.updateThumbnail(tab.id);
        }

        sendMessage({
            action: 'tab-updated',
            tab: {
                id: tab.id,
                ...changeInfo,
            },
        });
    }
}

async function checkTemporaryContainer(cookieStoreId, excludeTabId) {
    let tabs = await Tabs.get(null, null, null, {cookieStoreId});

    if (!tabs.filter(tab => tab.id !== excludeTabId).length) {
        await containers.remove(cookieStoreId);
    }
}

function onRemovedTab(tabId, {isWindowClosing, windowId}) {
    let excludeTab = excludeTabsIds.includes(tabId);

    console.log('onRemovedTab', (excludeTab && '🛑'), {tabId, isWindowClosing, windowId});

    if (excludeTab) {
        return;
    }

    sendMessage({
        action: 'tab-removed',
        tabId: tabId,
    });

    if (isWindowClosing) {
        reCreateTabsOnRemoveWindow.push(tabId);
    } else {
        let tabCookieStoreId = cache.getTabCookieStoreId(tabId);

        if (containers.isTemporary(tabCookieStoreId)) {
            setTimeout(checkTemporaryContainer, 100, tabCookieStoreId, tabId);
        }

        cache.removeTab(tabId);
    }
}

let _onMovedTabsTimers = {};
function updateGroupTabsEvent(groupId) {
    if (_onMovedTabsTimers[groupId]) {
        clearTimeout(_onMovedTabsTimers[groupId]);
    }

    _onMovedTabsTimers[groupId] = setTimeout(async function(groupId) {
        delete _onMovedTabsTimers[groupId];

        let [{tabs}] = await Groups.load(groupId, true);

        sendMessage({
            action: 'group-updated',
            group: {
                id: groupId,
                tabs,
            },
        });
    }, 200, groupId);
}

async function onMovedTab(tabId, { windowId, fromIndex, toIndex }) {
    console.log('onMovedTab', {tabId, windowId, fromIndex, toIndex });

    let groupId = cache.getTabSession(tabId, 'groupId');

    console.log('onMovedTab groupId', groupId);

    if (groupId) {
        updateGroupTabsEvent(groupId);
    }
}

function onAttachedTab(tabId, { newWindowId, newPosition }) {
    let excludeTab = excludeTabsIds.includes(tabId);

    console.log('onAttachedTab', (excludeTab && '🛑'), { tabId, newWindowId, newPosition });

    if (excludeTab) {
        return;
    }

    let groupId = cache.getWindowGroup(newWindowId);

    cache.setTabGroup(tabId, groupId);

    if (groupId) {
        updateGroupTabsEvent(groupId);
    }
}

function onDetachedTab(tabId, { oldWindowId }) { // notice: call before onAttached
    console.log('onDetachedTab', { tabId, oldWindowId });
}

async function onCreatedWindow(win) {
    console.log('onCreatedWindow', win);

    if (utils.isWindowAllow(win)) {
        win = await cache.loadWindowSession(win);

        if (win.session.groupId) {
            await cache.removeWindowGroup(win.id);

            updateBrowserActionData(null, win.id);

            let winTabs = await Tabs.get(win.id, null, null);
            winTabs.forEach(tab => cache.removeTabGroup(tab.id));
        } else if (options.createNewGroupWhenOpenNewWindow && window.BG.canAddGroupToWindowAfterItCreated) {
            Groups.add(win.id);
        }
    } else {
        let winTabs = await Tabs.get(win.id, null, null, {
            windowType: null,
        });

        winTabs.forEach(tab => excludeTabsIds.push(tab.id));
    }
}

let _lastFocusedWinId = null;
function onFocusChangedWindow(windowId) {
    // console.log('onFocusChangedWindow', windowId);

    if (browser.windows.WINDOW_ID_NONE === windowId) {
        return;
    }

    if (_lastFocusedWinId !== windowId) {
        updateMoveTabMenus(windowId);
    }

    _lastFocusedWinId = windowId;
}

async function onRemovedWindow(windowId) {
    console.log('onRemovedWindow windowId:', windowId);

    cache.removeWindow(windowId);

    if (reCreateTabsOnRemoveWindow.length) {
        let tabsToCreate = cache.getRemovedTabsForCreate(reCreateTabsOnRemoveWindow);

        reCreateTabsOnRemoveWindow = [];

        if (tabsToCreate.length) {
            let [windows, groups] = await Promise.all([Windows.load(), Groups.load()]);

            windows.forEach(win => win.id !== windowId && loadingBrowserAction(true, win.id));

            tabsToCreate.forEach(tab => tab.group = groups.find(group => group.id === tab.groupId));
            await createTabsSafe(tabsToCreate, true);

            windows.forEach(win => win.id !== windowId && loadingBrowserAction(false, win.id));
        }
    }
}

let _currentWindowForLoadingBrowserAction = null;
async function loadingBrowserAction(start = true, windowId) {
    if (start) {
        _currentWindowForLoadingBrowserAction = windowId || await Windows.getLastFocusedNormalWindow();

        setBrowserAction(_currentWindowForLoadingBrowserAction, 'loading', undefined, false);
    } else {
        if (windowId) {
            _currentWindowForLoadingBrowserAction = windowId;
        }

        updateBrowserActionData(null, _currentWindowForLoadingBrowserAction);
    }
}

async function addUndoRemoveGroupItem(groupToRemove) {
    let restoreGroup = async function(group) {
        browser.menus.remove(Groups.CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id);
        browser.notifications.clear(Groups.CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id);

        let tabs = group.tabs,
            groups = await Groups.load();

        groups.push(group);

        await Groups.save(groups, true);

        updateMoveTabMenus();

        if (tabs.length) {
            await loadingBrowserAction();

            await createTabsSafe(tabs.map(function(tab) {
                delete tab.active;
                delete tab.windowId;
                tab.group = group;

                return tab;
            }), true);

            loadingBrowserAction(false);
        }
    }.bind(null, utils.clone(groupToRemove));

    browser.menus.create({
        id: Groups.CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + groupToRemove.id,
        title: browser.i18n.getMessage('undoRemoveGroupItemTitle', groupToRemove.title),
        contexts: [browser.menus.ContextType.BROWSER_ACTION],
        icons: utils.getGroupIconUrl(groupToRemove, 16),
        onclick: restoreGroup,
    });

    if (options.showNotificationAfterGroupDelete) {
        utils.notify(
                browser.i18n.getMessage('undoRemoveGroupNotification', groupToRemove.title),
                undefined,
                Groups.CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + groupToRemove.id,
                false
            )
            .then(restoreGroup, noop);
    }
}

async function updateMoveTabMenus(windowId) {
    await removeMoveTabMenus();
    await createMoveTabMenus(windowId);
}

async function removeMoveTabMenus() {
    if (menuIds.length) {
        await Promise.all(menuIds.map(id => browser.menus.remove(id).catch(noop)));
        menuIds = [];
    }
}

async function createMoveTabMenus(windowId) {
    let hasBookmarksPermission = await browser.permissions.contains(constants.PERMISSIONS.BOOKMARKS);

    if (!options.showContextMenuOnTabs && !options.showContextMenuOnLinks && !hasBookmarksPermission) {
        return;
    }

    windowId = windowId || await Windows.getLastFocusedNormalWindow();

    let groupId = cache.getWindowGroup(windowId),
        [currentGroup, groups] = await Groups.load(groupId || -1);

    await removeMoveTabMenus();

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        id: 'stg-open-bookmark-in-group-parent',
        title: browser.i18n.getMessage('openBookmarkInGroup'),
        contexts: [browser.menus.ContextType.BOOKMARK],
    }));

    options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
        id: 'stg-move-tab-parent',
        title: browser.i18n.getMessage('moveTabToGroupDisabledTitle'),
        contexts: [browser.menus.ContextType.TAB],
    }));

    options.showContextMenuOnLinks && menuIds.push(browser.menus.create({
        id: 'stg-open-link-parent',
        title: browser.i18n.getMessage('openLinkInGroupDisabledTitle'),
        contexts: [browser.menus.ContextType.LINK],
    }));

    groups.forEach(function(group) {
        let groupIcon = utils.getGroupIconUrl(group, 16),
            groupTitle = String(utils.getGroupTitle(group, 'withActiveGroup withContainer'));

        options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
            title: groupTitle,
            icons: groupIcon,
            parentId: 'stg-move-tab-parent',
            contexts: [browser.menus.ContextType.TAB],
            onclick: async function(info, tab) {
                let setActive = 2 === info.button,
                    tabsToMove = await Tabs.getHighlighted(tab.windowId, tab);

                await Tabs.move(tabsToMove, group.id, undefined, undefined, setActive);

                if (!setActive && info.modifiers.includes('Ctrl')) {
                    Tabs.discard(tabsToMove.map(utils.keyId));
                }
            },
        }));

        options.showContextMenuOnLinks && menuIds.push(browser.menus.create({
            title: groupTitle,
            icons: groupIcon,
            parentId: 'stg-open-link-parent',
            contexts: [browser.menus.ContextType.LINK],
            onclick: async function(info) {
                if (!utils.isUrlAllowToCreate(info.linkUrl)) {
                    return;
                }

                let setActive = 2 === info.button,
                    newTab = await Tabs.add(group.id, undefined, info.linkUrl, info.linkText, setActive);

                if (setActive) {
                    applyGroup(newTab.windowId, group.id, newTab.id);
                }
            },
        }));

        hasBookmarksPermission && menuIds.push(browser.menus.create({
            title: groupTitle,
            icons: groupIcon,
            parentId: 'stg-open-bookmark-in-group-parent',
            contexts: [browser.menus.ContextType.BOOKMARK],
            onclick: async function(info) {
                if (!info.bookmarkId) {
                    utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                    return;
                }

                await loadingBrowserAction();

                let setActive = 2 === info.button,
                    [bookmark] = await browser.bookmarks.getSubTree(info.bookmarkId),
                    tabsToCreate = [];

                if (bookmark.type === browser.menus.ContextType.BOOKMARK) {
                    if (utils.isUrlAllowToCreate(bookmark.url)) {
                        tabsToCreate.push({
                            title: bookmark.title,
                            url: bookmark.url,
                            group,
                        });
                    }
                } else if (bookmark.type === 'folder') {
                    await findBookmarks(bookmark);
                }

                async function findBookmarks(folder) {
                    for (let b of folder.children) {
                        if (b.type === 'folder') {
                            await findBookmarks(b);
                        } else if (b.type === browser.menus.ContextType.BOOKMARK && utils.isUrlAllowToCreate(b.url)) {
                            tabsToCreate.push({
                                title: b.title,
                                url: b.url,
                                group,
                            });
                        }
                    }
                }

                if (tabsToCreate.length) {
                    let tabs = await createTabsSafe(tabsToCreate, !cache.getWindowId(group.id));

                    loadingBrowserAction(false);

                    if (setActive) {
                        applyGroup(undefined, group.id, tabs[0].id);
                    } else {
                        utils.notify(browser.i18n.getMessage('tabsCreatedCount', tabsToCreate.length), 7000);
                    }
                } else {
                    loadingBrowserAction(false);
                    utils.notify(browser.i18n.getMessage('tabsNotCreated'), 7000);
                }
            },
        }));
    });

    options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('createNewGroup'),
        icons: {
            16: '/icons/group-new.svg',
        },
        parentId: 'stg-move-tab-parent',
        contexts: [browser.menus.ContextType.TAB],
        onclick: async function(info, tab) {
            let setActive = 2 === info.button,
                tabsToMove = await Tabs.getHighlighted(tab.windowId, tab);

            Groups.add(undefined, tabsToMove, undefined, setActive);
        },
    }));

    options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
        type: browser.menus.ItemType.SEPARATOR,
        parentId: 'stg-move-tab-parent',
        contexts: [browser.menus.ContextType.TAB],
    }));

    options.showContextMenuOnTabs && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('setTabIconAsGroupIcon'),
        enabled: Boolean(currentGroup),
        icons: {
            16: '/icons/image.svg',
        },
        parentId: 'stg-move-tab-parent',
        contexts: [browser.menus.ContextType.TAB],
        onclick: function(info, tab) {
            let groupId = cache.getWindowGroup(tab.windowId);

            if (!groupId) {
                return;
            }

            let iconUrl = utils.normalizeFavIcon(cache.getTabSession(tab.id, 'favIconUrl'));

            Groups.update(groupId, {iconUrl});
        }
    }));

    options.showContextMenuOnLinks && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('createNewGroup'),
        icons: {
            16: '/icons/group-new.svg',
        },
        parentId: 'stg-open-link-parent',
        contexts: [browser.menus.ContextType.LINK],
        onclick: async function(info) {
            if (!utils.isUrlAllowToCreate(info.linkUrl)) {
                return;
            }

            let newTab = await Tabs.add(undefined, undefined, info.linkUrl, info.linkText);
            Groups.add(undefined, [newTab], undefined, 2 === info.button);
        },
    }));

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('createNewGroup'),
        icons: {
            16: '/icons/group-new.svg',
        },
        parentId: 'stg-open-bookmark-in-group-parent',
        contexts: [browser.menus.ContextType.BOOKMARK],
        onclick: async function(info) {
            if (!info.bookmarkId) {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                return;
            }

            let [bookmark] = await browser.bookmarks.get(info.bookmarkId);

            if (bookmark.type !== browser.menus.ContextType.BOOKMARK || !utils.isUrlAllowToCreate(bookmark.url)) {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                return;
            }

            let newTab = await Tabs.add(undefined, undefined, bookmark.url, bookmark.title);
            Groups.add(undefined, [newTab], undefined, 2 === info.button);
        },
    }));

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        type: browser.menus.ItemType.SEPARATOR,
        parentId: 'stg-open-bookmark-in-group-parent',
        contexts: [browser.menus.ContextType.BOOKMARK],
    }));

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('importBookmarkFolderAsNewGroup'),
        icons: {
            16: '/icons/bookmark-o.svg',
        },
        parentId: 'stg-open-bookmark-in-group-parent',
        contexts: [browser.menus.ContextType.BOOKMARK],
        onclick: async function(info) {
            if (!info.bookmarkId) {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                return;
            }

            let [folder] = await browser.bookmarks.getSubTree(info.bookmarkId),
                groupsCreatedCount = 0;

            if (folder.type !== 'folder') {
                utils.notify(browser.i18n.getMessage('bookmarkNotAllowed'));
                return;
            }

            async function addBookmarkFolderAsGroup(folder) {
                let tabsToCreate = [];

                for (let bookmark of folder.children) {
                    if (bookmark.type === 'folder') {
                        await addBookmarkFolderAsGroup(bookmark);
                    } else if (bookmark.type === browser.menus.ContextType.BOOKMARK && utils.isUrlAllowToCreate(bookmark.url)) {
                        tabsToCreate.push({
                            title: bookmark.title,
                            url: bookmark.url,
                        });
                    }
                }

                if (tabsToCreate.length) {
                    let tabs = await createTabsSafe(tabsToCreate, true);
                    await Groups.add(undefined, tabs, folder.title);
                    groupsCreatedCount++;
                }
            }

            await loadingBrowserAction();

            await addBookmarkFolderAsGroup(folder);

            loadingBrowserAction(false);

            if (groupsCreatedCount) {
                utils.notify(browser.i18n.getMessage('groupsCreatedCount', groupsCreatedCount), 7000);
            } else {
                utils.notify(browser.i18n.getMessage('noGroupsCreated'), 7000);
            }
        },
    }));

    hasBookmarksPermission && menuIds.push(browser.menus.create({
        title: browser.i18n.getMessage('exportAllGroupsToBookmarks'),
        icons: {
            16: '/icons/bookmark.svg',
        },
        contexts: [browser.menus.ContextType.BROWSER_ACTION],
        onclick: () => exportAllGroupsToBookmarks(true),
    }));
}

async function _getBookmarkFolderFromTitle(title, parentId, index) {
    let bookmarks = await browser.bookmarks.search({
            title,
        }),
        bookmark = bookmarks.find(b => b.type === 'folder' && b.parentId === parentId);

    if (!bookmark) {
        let bookmarkData = {
            title,
            parentId,
            type: 'folder',
        };

        if (Number.isFinite(index)) {
            bookmarkData.index = index;
        }

        bookmark = await browser.bookmarks.create(bookmarkData);
    }

    if (bookmark) {
        bookmark.children = await browser.bookmarks.getChildren(bookmark.id);
    }

    return bookmark;
}

async function exportGroupToBookmarks(group, groupIndex, showMessages = true) {
    let hasBookmarksPermission = await browser.permissions.contains(constants.PERMISSIONS.BOOKMARKS);

    if (!hasBookmarksPermission) {
        showMessages && utils.notify(browser.i18n.getMessage('noAccessToBookmarks'), undefined, undefined, false)
            .then(() => browser.runtime.openOptionsPage(), noop);
        return;
    }

    if (!group) {
        throw TypeError('group has invalid type in exportGroupToBookmarks');
    }

    if (Number.isFinite(group)) {
        let [gr, groups, index] = await Groups.load(group, true);
        group = gr;
        groupIndex = index;
    }

    if (!group.tabs.length) {
        showMessages && utils.notify(browser.i18n.getMessage('groupWithoutTabs'));
        return;
    }

    if (showMessages) {
        loadingBrowserAction(true);
    }

    let rootFolder = {
        id: options.defaultBookmarksParent,
    };

    if (options.exportGroupToMainBookmarkFolder) {
        rootFolder = await _getBookmarkFolderFromTitle(options.autoBackupBookmarksFolderName, options.defaultBookmarksParent);
    }

    groupIndex = options.exportGroupToMainBookmarkFolder ? groupIndex : undefined;

    let groupBookmarkFolder = await _getBookmarkFolderFromTitle(group.title, rootFolder.id, groupIndex);

    if (groupBookmarkFolder.children.length) {
        let bookmarksToRemove = [];

        group.tabs.forEach(function(tab) {
            groupBookmarkFolder.children = groupBookmarkFolder.children.filter(function(bookmark) {
                if (bookmark.type === browser.menus.ContextType.BOOKMARK) {
                    if (bookmark.url === tab.url) {
                        bookmarksToRemove.push(bookmark);
                        return false;
                    }

                    return true;
                }
            });
        });

        await Promise.all(bookmarksToRemove.map(bookmark => browser.bookmarks.remove(bookmark.id).catch(noop)));

        let children = await browser.bookmarks.getChildren(groupBookmarkFolder.id);

        if (children.length) {
            if (children[0].type !== browser.menus.ItemType.SEPARATOR) {
                await browser.bookmarks.create({
                    type: browser.menus.ItemType.SEPARATOR,
                    index: 0,
                    parentId: groupBookmarkFolder.id,
                });
            }

            // found and remove duplicated separators
            let duplicatedSeparators = children.filter(function(separator, index) {
                return separator.type === browser.menus.ItemType.SEPARATOR &&
                    children[index - 1] &&
                    children[index - 1].type === browser.menus.ItemType.SEPARATOR;
            });

            if (children[children.length - 1].type === browser.menus.ItemType.SEPARATOR && !duplicatedSeparators.includes(children[children.length - 1])) {
                duplicatedSeparators.push(children[children.length - 1]);
            }

            if (duplicatedSeparators.length) {
                await Promise.all(duplicatedSeparators.map(separator => browser.bookmarks.remove(separator.id).catch(noop)));
            }
        }
    }

    for (let index in group.tabs) {
        await browser.bookmarks.create({
            title: group.tabs[index].title,
            url: group.tabs[index].url,
            type: browser.menus.ContextType.BOOKMARK,
            index: Number(index),
            parentId: groupBookmarkFolder.id,
        });
    }

    if (showMessages) {
        loadingBrowserAction(false);
        utils.notify(browser.i18n.getMessage('groupExportedToBookmarks', group.title), 7000);
    }

    return true;
}

function setBrowserAction(windowId, title, icon, enable) {
    console.info('setBrowserAction', {windowId, title, icon, enable});

    let winObj = windowId ? {windowId} : {};

    if ('loading' === title) {
        title = 'lang:loading';
        icon = 'loading';
    }

    if (title && title.startsWith('lang:')) {
        title = browser.i18n.getMessage(title.slice(5));
    }

    browser.browserAction.setTitle({
        ...winObj,
        title: title || manifest.browser_action.default_title,
    });

    if ('loading' === icon) {
        icon = '/icons/animate-spinner.svg';
    }

    browser.browserAction.setIcon({
        ...winObj,
        path: icon || manifest.browser_action.default_icon,
    });

    if (undefined !== enable) {
        if (enable) {
            browser.browserAction.enable();
        } else {
            browser.browserAction.disable();
        }
    }
}

async function updateBrowserActionData(groupId, windowId) {
    console.log('updateBrowserActionData', {groupId, windowId});

    if (groupId) {
        windowId = cache.getWindowId(groupId);
    } else if (windowId) {
        groupId = cache.getWindowGroup(windowId);
    }

    if (!windowId) {
        return;
    }

    let group = null;

    if (groupId) {
        [group] = await Groups.load(groupId);
    }

    if (group) {
        setBrowserAction(windowId, utils.sliceText(utils.getGroupTitle(group, 'withContainer'), 43) + ' - STG', utils.getGroupIconUrl(group), true);
        prependWindowTitle(windowId, group.title);
    } else {
        setBrowserAction(windowId, undefined, undefined, true);
        prependWindowTitle(windowId);
    }
}

function prependWindowTitle(windowId, title) {
    if (windowId) {
        browser.windows.update(windowId, {
            titlePreface: options.prependGroupTitleToWindowTitle && title ? ('[' + utils.sliceText(title, 35) + '] ') : '',
        });
    }
}

let _tabsLazyMoving = {},
    _tabsLazyMovingTimer = 0;

function addTabToLazyMove(tab, groupId, showTabAfterMovingItIntoThisGroup) {
    clearTimeout(_tabsLazyMovingTimer);

    if (!_tabsLazyMoving[groupId]) {
        _tabsLazyMoving[groupId] = {
            id: groupId,
            tabs: [],
            showTabAfterMovingItIntoThisGroup,
        };
    }

    if (!_tabsLazyMoving[groupId].tabs.some(t => t.id === tab.id)) {
        _tabsLazyMoving[groupId].tabs.push(tab);
    }

    _tabsLazyMovingTimer = window.setTimeout(async function() {
        let groups = Object.values(_tabsLazyMoving);

        _tabsLazyMoving = {};

        for (let group of groups) {
            await Tabs.move(group.tabs, group.id, undefined, undefined, group.showTabAfterMovingItIntoThisGroup);
        }
    }, 100);
}

async function onBeforeTabRequest({tabId, url, originUrl}) {
    let excludeTab = excludeTabsIds.includes(tabId);

    console.log('onBeforeTabRequest %s tabId: %s, url: %s', (excludeTab ? '🛑' : ''), tabId, url);

    if (excludeTab) {
        return;
    }

    let tab = await browser.tabs.get(tabId);

    if (utils.isTabPinned(tab)) {
        console.log('onBeforeTabRequest 🛑 cancel, tab is pinned');
        return;
    }

    if (containers.isTemporary(tab.cookieStoreId)) {
        console.log('onBeforeTabRequest 🛑 cancel, container is temporary', tab.cookieStoreId);
        return;
    }

    tab.url = url;

    // tab = await cache.loadTabSession(tab);
    tab.session = cache.getTabSession(tab.id);

    console.log('onBeforeRequest tab session', {...tab.session});

    let [tabGroup, groups] = await Groups.load(tab.session.groupId || -1);

    if (!tabGroup) {
        return;
    }

    if (!tabGroup.isSticky && tabGroup.newTabContainer !== containers.TEMPORARY_CONTAINER) {
        let destGroup = _getCatchedGroupForTab(groups, tab);

        if (destGroup && destGroup.id !== tabGroup.id) {
            console.log('onBeforeTabRequest move tab from groupId %d -> %d', tabGroup.id, destGroup.id);
            addTabToLazyMove(tab, destGroup.id, destGroup.showTabAfterMovingItIntoThisGroup);
            return;
        }
    }

    if (
        !tabGroup.newTabContainer ||
        tabGroup.newTabContainer === tab.cookieStoreId ||
        (!containers.isDefault(tab.cookieStoreId) && !tabGroup.ifNotDefaultContainerReOpenInNew)
    ) {
        return;
    }

    if (originUrl && originUrl.startsWith('moz-extension') && !originUrl.startsWith(addonUrlPrefix)) {
        console.log('onBeforeTabRequest 🛑 cancel by another addon', originUrl);
        return;
    }

    console.log('onBeforeTabRequest create tab', tab);

    let groupWindowId = cache.getWindowId(tabGroup.id);

    let newTab = await Tabs.create({
        url: tab.url,
        cookieStoreId: tabGroup.newTabContainer,
        group: tabGroup,
        active: tab.active,
        index: tab.index,
        windowId: groupWindowId || tab.windowId,
    });

    if (!groupWindowId || tab.hidden) {
        addExcludeTabsIds([newTab.id]);
        await browser.tabs.hide(newTab.id);
        removeExcludeTabsIds([newTab.id]);
    }

    Tabs.remove(tab.id);

    return {
        cancel: true,
    };
}

// wait for reload addon if found update
browser.runtime.onUpdateAvailable.addListener(function() {
    let interval = setInterval(function() {
        if (console.lastUsage < (Date.now() - 1000 * 30)) {
            clearInterval(interval);
            browser.runtime.reload();
        }
    }, 1000);
});

function addEvents() {
    browser.tabs.onCreated.addListener(onCreatedTab);
    browser.tabs.onActivated.addListener(onActivatedTab);
    browser.tabs.onMoved.addListener(onMovedTab);
    browser.tabs.onUpdated.addListener(onUpdatedTab, {
        urls: ['<all_urls>'],
        properties: [
            browser.tabs.UpdatePropertyName.DISCARDED, // not work if tab load
            browser.tabs.UpdatePropertyName.FAVICONURL,
            browser.tabs.UpdatePropertyName.HIDDEN,
            browser.tabs.UpdatePropertyName.PINNED,
            browser.tabs.UpdatePropertyName.TITLE,
            browser.tabs.UpdatePropertyName.STATUS,
        ],
    });
    browser.tabs.onRemoved.addListener(onRemovedTab);

    browser.tabs.onAttached.addListener(onAttachedTab);
    browser.tabs.onDetached.addListener(onDetachedTab);

    browser.windows.onCreated.addListener(onCreatedWindow);
    browser.windows.onFocusChanged.addListener(onFocusChangedWindow);
    browser.windows.onRemoved.addListener(onRemovedWindow);

    browser.webRequest.onBeforeRequest.addListener(onBeforeTabRequest,
        {
            urls: ['<all_urls>'],
            types: ['main_frame'],
        },
        ['blocking']
    );
}

function removeEvents() {
    browser.tabs.onCreated.removeListener(onCreatedTab);
    browser.tabs.onActivated.removeListener(onActivatedTab);
    browser.tabs.onMoved.removeListener(onMovedTab);
    browser.tabs.onUpdated.removeListener(onUpdatedTab);
    browser.tabs.onRemoved.removeListener(onRemovedTab);

    browser.tabs.onAttached.removeListener(onAttachedTab);
    browser.tabs.onDetached.removeListener(onDetachedTab);

    browser.windows.onCreated.removeListener(onCreatedWindow);
    browser.windows.onFocusChanged.removeListener(onFocusChangedWindow);
    browser.windows.onRemoved.removeListener(onRemovedWindow);

    browser.webRequest.onBeforeRequest.removeListener(onBeforeTabRequest);
}

async function openManageGroups() {
    if (options.openManageGroupsInTab) {
        let tabs = await Tabs.get(undefined, null, null, {
            url: manageTabsPageUrl,
        });

        if (tabs.length) { // if manage tab is found
            await Tabs.setActive(tabs[0].id);
        } else {
            await Tabs.create({
                active: true,
                url: manageTabsPageUrl,
            });
        }
    } else {
        let allWindows = await browser.windows.getAll({
            populate: true,
            windowTypes: [browser.windows.WindowType.POPUP],
        });

        let popupWindow = allWindows.find(win => browser.windows.WindowType.POPUP === win.type && 1 === win.tabs.length && manageTabsPageUrl === win.tabs[0].url);

        if (popupWindow) {
            await Windows.setFocus(popupWindow.id);
        } else {
            await Windows.create({
                url: manageTabsPageUrl,
                type: browser.windows.CreateType.POPUP,
                width: Number(window.localStorage.manageGroupsWindowWidth) || 1000,
                height: Number(window.localStorage.manageGroupsWindowHeight) || 700,
            });
        }
    }
}

browser.runtime.onMessage.addListener(function(request, sender) {
    if (!utils.isAllowSender(request, sender)) {
        return {
            unsubscribe: true,
        };
    }

    if (request.action) {
        return runAction(request);
    }
});

browser.runtime.onMessageExternal.addListener(function(request, sender, sendResponse) {
    let extensionRules = {};

    if (!window.BG.inited) {
        sendResponse({
            ok: false,
            error: '[STG] I am not yet loaded',
        });
        return;
    }

    if (!utils.isAllowExternalRequestAndSender(request, sender, extensionRules)) {
        sendResponse({
            ok: false,
            error: '[STG] Your extension/action does not in white list. If you want to add your extension/action to white list - please contact with me.',
            yourExtentionRules: extensionRules,
        });
        return;
    }

    if (request.action) {
        sendResponse(runAction(request, sender.id));
    } else {
        sendResponse({
            ok: false,
            error: 'unknown action',
        });
    }
});

browser.commands.onCommand.addListener(function(command) {
    runAction({
        action: command,
    });
});

async function runAction(data, externalExtId) {
    let result = {
        ok: false,
    };

    if (!data.action) {
        result.error = '[STG] Action or it\'s id is empty';
        return result;
    }

    console.info('runAction data.action:', data.action);

    try {
        let currentWindow = await Windows.getLastFocusedNormalWindow(false),
            loadCurrentGroupWithTabs = currentWindow.session.groupId ? ['discard-group', 'discard-other-groups', 'reload-all-tabs-in-current-group'].includes(data.action) : false,
            [currentGroup, groups] = await Groups.load(currentWindow.session.groupId || -1, loadCurrentGroupWithTabs);

        if (!currentGroup) {
            currentGroup = {
                id: 0,
            };
        }

        switch (data.action) {
            case 'are-you-here':
                result.ok = true;
                break;
            case 'get-groups-list':
                result.groupsList = groups.map(Groups.mapGroupForExternalExtension);
                result.ok = true;
                break;
            case 'load-next-group':
                result.ok = await applyGroupByPosition('next', groups, currentGroup.id);
                break;
            case 'load-prev-group':
                result.ok = await applyGroupByPosition('prev', groups, currentGroup.id);
                break;
            case 'load-next-unloaded-group':
                result.ok = await applyGroupByPosition('next', groups.filter(group => !cache.getWindowId(group.id) || group.id === currentGroup.id), currentGroup.id);
                break;
            case 'load-prev-unloaded-group':
                result.ok = await applyGroupByPosition('prev', groups.filter(group => !cache.getWindowId(group.id) || group.id === currentGroup.id), currentGroup.id);
                break;
            case 'load-history-next-group':
                result.ok = await applyGroupByHistory('next', groups);
                break;
            case 'load-history-prev-group':
                result.ok = await applyGroupByHistory('prev', groups);
                break;
            case 'load-first-group':
                if (groups[0]) {
                    await applyGroup(currentWindow.id, groups[0].id);
                    result.ok = true;
                }
                break;
            case 'load-last-group':
                if (groups.length > 0) {
                    await applyGroup(currentWindow.id, groups[groups.length - 1].id);
                    result.ok = true;
                }
                break;
            case 'load-custom-group':
                if (Number.isFinite(data.groupId) && 0 < data.groupId) {
                    if (groups.some(group => group.id === data.groupId)) {
                        await applyGroup(currentWindow.id, data.groupId);
                        result.ok = true;
                    } else {
                        data.groupId = 0;
                        result = await runAction(data, externalExtId);
                    }
                } else if ('new' === data.groupId) {
                    await Groups.add();
                    result = await runAction({
                        action: 'load-last-group',
                    }, externalExtId);
                } else {
                    let activeTab = await Tabs.getActive();

                    if (!Tabs.isCanSendMessage(activeTab.url)) {
                        utils.notify(browser.i18n.getMessage('thisTabIsNotSupported'), 7000);
                        break;
                    }

                    Tabs.sendMessage(activeTab.id, {
                        action: 'show-groups-popup',
                        popupAction: 'load-custom-group',
                        popupTitleLang: 'hotkeyActionTitleLoadCustomGroup',
                        groups: groups.map(Groups.mapGroupForExternalExtension),
                        disableGroupIds: [currentGroup.id],
                    });

                    result.ok = true;
                }
                break;
            case 'add-new-group':
                let newGroup = await Groups.add();
                result.ok = true;
                result.group = Groups.mapGroupForExternalExtension(newGroup);
                break;
            case 'delete-current-group':
                if (currentGroup.id) {
                    await Groups.remove(currentGroup.id);

                    if (externalExtId) {
                        utils.notify(browser.i18n.getMessage('groupRemovedByExtension', [currentGroup.title, utils.getSupportedExternalExtensionName(externalExtId)]));
                    }

                    result.ok = true;
                } else {
                    throw Error('There are no group in the current window');
                }

                break;
            case 'open-manage-groups':
                await openManageGroups();
                result.ok = true;
                break;
            case 'move-active-tab-to-custom-group':
                let activeTab = await Tabs.getActive();

                if (utils.isTabPinned(activeTab)) {
                    utils.notify(browser.i18n.getMessage('pinnedTabsAreNotSupported'));
                    break;
                } else if (utils.isTabCanNotBeHidden(activeTab)) {
                    utils.notify(browser.i18n.getMessage('thisTabsCanNotBeHidden', utils.getTabTitle(activeTab, false, 25)));
                    break;
                }

                if (Number.isFinite(data.groupId) && 0 < data.groupId) {
                    if (groups.some(group => group.id === data.groupId)) {
                        await Tabs.move([activeTab], data.groupId);
                        result.ok = true;
                    } else {
                        data.groupId = 0;
                        result = await runAction(data, externalExtId);
                    }
                } else if ('new' === data.groupId) {
                    await Groups.add(undefined, [activeTab]);
                    result.ok = true;
                } else {
                    if (!Tabs.isCanSendMessage(activeTab.url)) {
                        utils.notify(browser.i18n.getMessage('thisTabIsNotSupported'), 7000);
                        break;
                    }

                    Tabs.sendMessage(activeTab.id, {
                        action: 'show-groups-popup',
                        popupAction: 'move-active-tab-to-custom-group',
                        popupTitleLang: 'moveTabToGroupDisabledTitle',
                        groups: groups.map(Groups.mapGroupForExternalExtension),
                        focusedGroupId: activeTab.session.groupId,
                    });
                    result.ok = true;
                }
                break;
            case 'discard-group':
                let groupToDiscard = groups.find(group => group.id === data.groupId);

                if (groupToDiscard) {
                    await Tabs.discard(groupToDiscard.tabs.map(utils.keyId));
                    result.ok = true;
                } else {
                    let activeTab = await Tabs.getActive();

                    if (!Tabs.isCanSendMessage(activeTab.url)) {
                        utils.notify(browser.i18n.getMessage('thisTabIsNotSupported'), 7000);
                        break;
                    }

                    Tabs.sendMessage(activeTab.id, {
                        action: 'show-groups-popup',
                        popupAction: 'discard-group',
                        popupTitleLang: 'discardGroupTitle',
                        groups: groups.map(Groups.mapGroupForExternalExtension),
                        focusedGroupId: currentGroup.id,
                        disableNewGroupItem: true,
                    });
                    result.ok = true;
                }
                break;
            case 'discard-other-groups':
                let tabIds = groups.reduce((acc, gr) => [...acc, ...(gr.id === currentGroup.id ? [] : gr.tabs.map(utils.keyId))], []);

                await Tabs.discard(tabIds);

                result.ok = true;
                break;
            case 'reload-all-tabs-in-current-group':
                if (currentGroup.id) {
                    await Tabs.reload(currentGroup.tabs.map(utils.keyId));
                    result.ok = true;
                }

                break;
            case 'create-new-tab':
                await Tabs.create({
                    active: true,
                    cookieStoreId: data.cookieStoreId,
                    group: currentGroup,
                });

                result.ok = true;

                break;
            default:
                throw Error(`Action '${data.action}' is wrong`);
                break;
        }

    } catch (e) {
        result.error = '[STG] ' + String(e);
        console.error(result.error);
    }

    return result;
}

async function saveOptions(_options) {
    if (!window.BG.inited) {
        console.error('background not yet inited');
        return;
    }

    _options = utils.clone(_options);

    console.debug('save options', _options);

    let optionsKeys = Object.keys(_options);

    if (!optionsKeys.every(key => constants.allOptionsKeys.includes(key))) {
        throw Error('some key in save options are not supported: ' + optionsKeys.join(', '));
    }

    Object.assign(options, _options);

    await storage.set(_options);

    if (optionsKeys.includes('hotkeys')) {
        let tabs = await Tabs.get(null, null, null, {
                discarded: false,
            }),
            actionData = {
                action: 'update-hotkeys',
            };

        tabs.forEach(tab => Tabs.sendMessage(tab.id, actionData));
    }

    if (optionsKeys.some(key => ['autoBackupEnable', 'autoBackupIntervalKey', 'autoBackupIntervalValue'].includes(key))) {
        resetAutoBackup();
    }

    if (optionsKeys.includes('prependGroupTitleToWindowTitle')) {
        Groups.load().then(groups => groups.forEach(group => updateBrowserActionData(group.id)));
    }

    if (optionsKeys.some(key => ['showContextMenuOnTabs', 'showContextMenuOnLinks'].includes(key))) {
        updateMoveTabMenus();
    }

    sendMessage({
        action: 'options-updated',
    });
}

let _autoBackupTimer = 0;
async function resetAutoBackup() {
    if (_autoBackupTimer) {
        clearTimeout(_autoBackupTimer);
        _autoBackupTimer = 0;
    }

    if (!options.autoBackupEnable) {
        return;
    }

    let now = utils.unixNow(),
        timer = 0,
        value = Number(options.autoBackupIntervalValue);

    if (isNaN(value) || 1 > value || 20 < value) {
        throw Error(utils.errorEventMessage('invalid autoBackupIntervalValue', options));
    }

    let intervalSec = null,
        overwrite = false;

    if ('hours' === options.autoBackupIntervalKey) {
        intervalSec = constants.HOUR_SEC;
    } else if ('days' === options.autoBackupIntervalKey) {
        if (1 === value) {
            // if backup will create every day - overwrite backups every 2 hours in order to keep as recent changes as possible
            overwrite = true;
            intervalSec = constants.HOUR_SEC * 2;
        } else {
            intervalSec = constants.DAY_SEC;
        }
    } else {
        throw Error(utils.errorEventMessage('invalid autoBackupIntervalKey', options));
    }

    let timeToBackup = value * intervalSec + options.autoBackupLastBackupTimeStamp;

    if (now > timeToBackup) {
        createBackup(options.autoBackupIncludeTabThumbnails, options.autoBackupIncludeTabFavIcons, true, overwrite);
        timer = value * intervalSec;
    } else {
        timer = timeToBackup - now;
    }

    _autoBackupTimer = setTimeout(resetAutoBackup, (timer + 10) * 1000);
}

async function createBackup(includeTabThumbnails, includeTabFavIcons, isAutoBackup = false, overwrite = false) {
    let [data, groups] = await Promise.all([storage.get(null), Groups.load(null, true)]);

    if (isAutoBackup && !data.groups.length) {
        return;
    }

    data.pinnedTabs = await Tabs.get(null, true, null);
    data.pinnedTabs = data.pinnedTabs
        .map(function({url, title, cookieStoreId, isInReaderMode}) {
            url = utils.normalizeUrl(url);
            return {url, title, cookieStoreId, isInReaderMode};
        })
        .filter(tab => utils.isUrlAllowToCreate(tab.url));

    if (!data.pinnedTabs.length) {
        delete data.pinnedTabs;
    }

    let containersToExport = [];

    data.groups = groups.map(function(group) {
        group.tabs = group.tabs
            .map(function({url, title, cookieStoreId, isInReaderMode, session}) {
                url = utils.normalizeUrl(url);

                let tab = {url, title};

                if (!containers.isDefault(cookieStoreId)) {
                    tab.cookieStoreId = cookieStoreId;

                    if (!containersToExport.includes(tab.cookieStoreId)) {
                        containersToExport.push(tab.cookieStoreId);
                    }
                }

                if (isInReaderMode) {
                    tab.isInReaderMode = true;
                }

                if (includeTabThumbnails || includeTabFavIcons) {
                    delete session.groupId;

                    if (!includeTabThumbnails) {
                        delete session.thumbnail;
                    }

                    if (!includeTabFavIcons) {
                        delete session.favIconUrl;
                    }

                    tab.session = session;
                }

                return tab;
            })
            .filter(tab => tab.url);

        containersToExport.push(...group.catchTabContainers, group.newTabContainer);

        return group;
    });

    let allContainers = containers.getAll();

    data.containers = {};

    containersToExport.filter(Boolean).forEach(function(cookieStoreId) {
        if (cookieStoreId !== containers.TEMPORARY_CONTAINER && !data.containers[cookieStoreId]) {
            data.containers[cookieStoreId] = allContainers[cookieStoreId];
        }
    });

    if (isAutoBackup) {
        data.autoBackupLastBackupTimeStamp = options.autoBackupLastBackupTimeStamp = utils.unixNow();

        if (options.autoBackupGroupsToFile) {
            file.backup(data, true, overwrite);
        }

        if (options.autoBackupGroupsToBookmarks) {
            exportAllGroupsToBookmarks();
        }

        storage.set({
            autoBackupLastBackupTimeStamp: data.autoBackupLastBackupTimeStamp,
        });
    } else {
        await file.backup(data, false, overwrite);
    }
}

async function restoreBackup(data) {
    removeEvents();

    await loadingBrowserAction();

    let {os} = await browser.runtime.getPlatformInfo(),
        isMac = os === browser.runtime.PlatformOs.MAC;

    let currentData = await storage.get(null),
        lastCreatedGroupPosition = Math.max(currentData.lastCreatedGroupPosition, data.lastCreatedGroupPosition || 0);

    currentData.groups = await Groups.load(null, true);

    data.groups = data.groups.map(function(group) {
        let newGroup = Groups.create(++lastCreatedGroupPosition, group.title);

        if (group.id && data.hotkeys) {
            data.hotkeys.forEach(hotkey => hotkey.groupId === group.id ? (hotkey.groupId = newGroup.id) : null);
        }

        delete group.id;
        delete group.title;

        newGroup = {
            ...newGroup,
            ...group,
        };

        newGroup.tabs = group.tabs
            .map(function(tab) {
                delete tab.active;
                delete tab.windowId;
                delete tab.index;
                delete tab.pinned;

                tab.group = newGroup;
                tab.url = utils.normalizeUrl(tab.url);

                return tab;
            })
            .filter(tab => utils.isUrlAllowToCreate(tab.url));

        if ('string' === typeof group.catchTabRules && group.catchTabRules.length) {
            newGroup.catchTabRules = group.catchTabRules;
        }

        return newGroup;
    });

    if (data.hotkeys && !isMac) {
        data.hotkeys.forEach(hotkey => hotkey.metaKey = false);
    }

    data = {
        ...currentData,
        ...data,
        lastCreatedGroupPosition,
        groups: [...currentData.groups, ...data.groups],
        hotkeys: [...currentData.hotkeys, ...(data.hotkeys || [])],
    };

    if (data.containers) {
        for (let cookieStoreId in data.containers) {
            let newCookieStoreId = await containers.normalize(cookieStoreId, data.containers[cookieStoreId]);

            if (newCookieStoreId !== cookieStoreId) {
                data.groups.forEach(function(group) {
                    if (group.newTabContainer === cookieStoreId) {
                        group.newTabContainer = newCookieStoreId;
                    }

                    group.catchTabContainers = group.catchTabContainers.map(csId => csId === cookieStoreId ? newCookieStoreId : csId);
                });
            }
        }
    }

    delete data.containers;

    let windows = await Windows.load(true);

    await syncTabs(data.groups, windows);

    if (data.pinnedTabs) {
        let currentPinnedTabs = await Tabs.get(null, true, null);

        data.pinnedTabs = data.pinnedTabs.filter(function(tab) {
            delete tab.active;
            delete tab.windowId;
            delete tab.index;

            tab.pinned = true;

            return !currentPinnedTabs.some(t => t.url === tab.url) && utils.isUrlAllowToCreate(tab.url);
        });

        if (data.pinnedTabs.length) {
            await createTabsSafe(data.pinnedTabs, false, false);
        }

        delete data.pinnedTabs;
    }

    data.isBackupRestoring = true;

    await storage.set(data);

    browser.runtime.reload(); // reload addon
}

async function clearAddon() {
    loadingBrowserAction();

    removeEvents();

    let [tabs, windows] = await Promise.all([Tabs.get(null, null, null), Windows.load()]);

    await Promise.all(tabs.map(tab => cache.removeTabSession(tab.id)));
    await Promise.all(windows.map(win => cache.removeWindowSession(win.id)));

    await storage.clear();

    if (tabs.length) {
        await browser.tabs.show(tabs.map(utils.keyId));
    }

    window.localStorage.clear();

    browser.runtime.reload(); // reload addon
}

async function exportAllGroupsToBookmarks(showFinishMessage) {
    let hasBookmarksPermission = await browser.permissions.contains(constants.PERMISSIONS.BOOKMARKS);

    if (!hasBookmarksPermission) {
        return;
    }

    if (showFinishMessage) {
        await loadingBrowserAction();
    }

    let groups = await Groups.load(null, true);

    for (let groupIndex in groups) {
        await exportGroupToBookmarks(groups[groupIndex], groupIndex, false);
    }

    if (showFinishMessage) {
        loadingBrowserAction(false);

        utils.notify(browser.i18n.getMessage('allGroupsExportedToBookmarks'));
    }
}

window.BG = {
    inited: false,
    startTime: Date.now(),

    cache,
    openManageGroups,

    getOptions: () => utils.clone(options),
    saveOptions,

    containers,
    normalizeContainersInGroups,

    Groups,
    Windows,

    createTabsSafe,

    addUndoRemoveGroupItem,

    addExcludeTabsIds,
    removeExcludeTabsIds,

    sendMessage,
    sendExternalMessage,

    setBrowserAction,
    updateBrowserActionData,
    updateMoveTabMenus,

    loadingBrowserAction,

    exportGroupToBookmarks,
    applyGroup,

    runMigrateForData,

    createBackup,
    restoreBackup,
    clearAddon,

    canAddGroupToWindowAfterItCreated: true,

    browser,

    console,
    async saveConsoleLogs() {
        let urls = {},
            index = 1;

        let logs = console.getLogs();

        function normalize(obj) {
            if (Array.isArray(obj)) {
                return obj.map(normalize);
            } else if ('object' === utils.type(obj)) {
                for (let i in obj) {
                    if (String(obj[i]).startsWith('data:image')) {
                        obj[i] = 'some image url';
                    } else if (['title', 'icon', 'icons', 'iconUrl', 'favIconUrl', 'thumbnail'].includes(i)) {
                        obj[i] = 'some ' + i;
                    } else if (String(obj[i]).startsWith('http')) {
                        obj[i] = urls[obj[i]] || (urls[obj[i]] = 'URL_' + index++);
                    } else {
                        obj[i] = normalize(obj[i]);
                    }
                }

                return obj;
            } else if (String(obj).startsWith('data:image')) {
                return 'some image url';
            }

            return obj;
        }

        file.save({
            info: await utils.getInfo(),
            logs: normalize(logs),
            errorLogs: utils.getErrorLogs(),
        }, 'STG-logs.json');
    },
};

function openHelp(page) {
    return browser.tabs.create({
        active: true,
        url: `/help/${page}.html`,
    });
}

async function runMigrateForData(data) {
    let currentVersion = manifest.version;

    if (data.version === currentVersion) {
        return data;
    }

    if (data.version === constants.DEFAULT_OPTIONS.version) {
        data.version = currentVersion;
        return data;
    }

    let migrations = [
        {
            version: '1.8.1',
            remove: ['windowsGroup'],
            migration() {
                data.groups = data.groups.map(function(group) {
                    group.windowId = data.windowsGroup[win.id] === group.id ? win.id : null;

                    group.catchTabRules = group.moveNewTabsToThisGroupByRegExp || '';
                    delete group.moveNewTabsToThisGroupByRegExp;

                    delete group.classList;
                    delete group.colorCircleHtml;
                    delete group.isExpanded;

                    if (group.iconColor === undefined || group.iconColor === 'undefined') { // fix missed group icons :)
                        group.iconColor = utils.randomColor();
                    }

                    return group;
                });
            },
        },
        {
            version: '2.2',
            remove: ['showGroupCircleInSearchedTab'],
            migration() {
                if ('showGroupCircleInSearchedTab' in data) {
                    data.showGroupIconWhenSearchATab = data.showGroupCircleInSearchedTab;
                }
            },
        },
        {
            version: '2.3',
            remove: ['enableKeyboardShortcutLoadNextPrevGroup', 'enableKeyboardShortcutLoadByIndexGroup'],
            migration() {
                data.groups = data.groups.map(function(group) {
                    group.tabs = group.tabs.filter(Boolean);
                    return group;
                });
            },
        },
        {
            version: '2.4',
            migration() {
                data.groups = data.groups.map(function(group) {
                    if (!group.catchTabContainers) {
                        group.catchTabContainers = [];
                    }

                    return group;
                });
            },
        },
        {
            version: '2.4.5',
            migration() {
                data.groups = data.groups.map(function(group) {
                    if (!group.iconColor.trim()) {
                        group.iconColor = 'transparent';
                    }

                    group.iconViewType = 'main-squares';

                    return group;
                });
            },
        },
        {
            version: '3.0',
            remove: ['enableFastGroupSwitching', 'enableFavIconsForNotLoadedTabs', 'createNewGroupAfterAttachTabToNewWindow', 'individualWindowForEachGroup', 'openNewWindowWhenCreateNewGroup', 'showNotificationIfGroupsNotSyncedAtStartup', 'showGroupIconWhenSearchATab', 'showUrlTooltipOnTabHover'],
            migration() {
                data.groups.forEach(group => group.title = utils.unSafeHtml(group.title));
            },
        },
        {
            version: '3.0.9',
            migration() {
                data.hotkeys.forEach(hotkey => 'metaKey' in hotkey ? null : hotkey.metaKey = false);
                data.groups.forEach(group => delete group.isExpanded);
            },
        },
        {
            version: '3.0.10',
            remove: ['browserActionIconColor'],
            migration() {
                data.hotkeys.forEach(function(hotkey) {
                    if (hotkey.action.groupId) {
                        hotkey.groupId = hotkey.action.groupId;
                    }

                    hotkey.action = hotkey.action.id;
                });
            },
        },
        {
            version: '3.1',
            migration() {
                if (!data.thumbnails) {
                    data.thumbnails = {};
                }

                data.groups.forEach(function(group) {
                    group.muteTabsWhenGroupCloseAndRestoreWhenOpen = false;
                    group.showTabAfterMovingItIntoThisGroup = false;

                    group.tabs.forEach(function(tab) {
                        if (tab.thumbnail && tab.url && !data.thumbnails[tab.url]) {
                            data.thumbnails[tab.url] = tab.thumbnail;
                        }

                        delete tab.thumbnail;
                    });
                });
            },
        },
        {
            version: '3.3.5',
            migration() {
                data.hotkeys.forEach(hotkey => hotkey.groupId = hotkey.groupId || 0);
            },
        },
        {
            version: '3.4.4',
            remove: ['createThumbnailsForTabs'],
            migration() {
                //
            },
        },
        {
            version: '4.0',
            remove: ['useTabsFavIconsFromGoogleS2Converter', 'doRemoveSTGNewTabUrls', 'thumbnails'],
            migration() {
                data.withoutSession = true;

                data.groups.forEach(function(group) {
                    delete group.windowId;
                    group.dontDiscardTabsAfterHideThisGroup = false;
                });
            },
        },
        {
            version: '4.1',
            remove: [],
            migration() {
                data.groups.forEach(group => group.newTabContainer = null);

                migrations.some(function(prevMigration) {
                    if (prevMigration === this) {
                        return true;
                    }

                    if (Array.isArray(prevMigration.remove)) {
                        this.remove.push(...prevMigration.remove);
                    }
                }, this);
            },
        },
        {
            version: '4.2',
            remove: ['followToLoadedGroupInSideBar'],
            migration() {
                data.openGroupAfterChange = data.followToLoadedGroupInSideBar;
            },
        },
        {
            version: '4.3.5',
            migration() {
                data.groups.forEach(group => group.ifNotDefaultContainerReOpenInNew = true);
            },
        },
    ];

    // start migration
    let keysToRemoveFromStorage = [];

    // if data version < required latest migrate version then need migration
    if (-1 === utils.compareVersions(data.version, migrations[migrations.length - 1].version)) {

        for (let migration of migrations) {
            if (-1 === utils.compareVersions(data.version, migration.version)) {
                await migration.migration();

                if (Array.isArray(migration.remove)) {
                    keysToRemoveFromStorage.push(...migration.remove);
                }
            }
        }

    } else if (1 === utils.compareVersions(data.version, currentVersion)) {
        let [currentMajor, currentMinor] = currentVersion.split('.'),
            [dataMajor, dataMinor] = data.version.split('.');

        if (dataMajor > currentMajor || (dataMajor == currentMajor && dataMinor > currentMinor)) {
            throw 'Please, update addon to latest version';
        }
    }

    data.version = currentVersion;

    if (keysToRemoveFromStorage.length) {
        keysToRemoveFromStorage.forEach(key => delete data[key]);
        await storage.remove(keysToRemoveFromStorage);
    }
    // end migration

    return data;
}

async function syncTabs(groups, windows, hideAllTabs = false) {
    let allTabs = windows.reduce((acc, win) => [...acc, ...win.tabs], []);

    if (hideAllTabs && allTabs.length) {
        await browser.tabs.hide(allTabs.map(utils.keyId));
    }

    for (let group of groups) {
        let tabs = [];

        for (let tab of group.tabs) {
            tab.cookieStoreId = await containers.normalize(tab.cookieStoreId);
            tab.url = utils.normalizeUrl(tab.url);

            let winTabIndex = allTabs.findIndex(winTab => winTab.url === tab.url && winTab.cookieStoreId === tab.cookieStoreId);

            if (winTabIndex !== -1) {
                let [winTab] = allTabs.splice(winTabIndex, 1);

                if (winTab.session.groupId !== group.id) {
                    winTab.session.groupId = group.id;
                    await cache.setTabGroup(winTab.id, group.id);
                }

                tabs.push(winTab);
            } else {
                if (utils.isUrlAllowToCreate(tab.url)) {
                    tabs.push(
                        Tabs.create({
                            title: tab.title,
                            url: tab.url,
                            favIconUrl: tab.favIconUrl,
                            thumbnail: tab.session && tab.session.thumbnail,
                            cookieStoreId: tab.cookieStoreId,
                            group,
                        })
                    );
                }
            }
        }

        group.tabs = await Promise.all(tabs);
    }

    // sort tabs
    for (let group of groups) {
        if (group.tabs.length) {
            group.tabs = await Tabs.moveNative(group.tabs, {
                index: -1,
                windowId: cache.getWindowId(group.id) || group.tabs[0].windowId,
            });
        }
    }

    return groups;
}

function isStgNewTabUrl(url) {
    return url.startsWith('moz-extension') && url.includes('/stg-newtab/newtab.html');
}

async function removeSTGNewTabUrls(windows) {
    return Promise.all(windows.map(async function(win) {
        await Promise.all(win.tabs.map(async function(winTab) {
            if (isStgNewTabUrl(winTab.url)) {
                winTab.url = utils.normalizeUrl(winTab.url);

                if (winTab.url) {
                    await browser.tabs.update(winTab.id, {
                        url: winTab.url,
                        loadReplace: true,
                    });
                }
            }
        }));

        return win;
    }));
}

async function normalizeContainersInGroups(groups = null) {
    let _groups = groups ? groups : await Groups.load(),
        allContainers = containers.getAll();

    _groups.forEach(function(group) {
        if (group.newTabContainer && group.newTabContainer !== containers.TEMPORARY_CONTAINER) {
            group.newTabContainer = containers.get(group.newTabContainer, 'cookieStoreId');
        }

        if (containers.isDefault(group.newTabContainer)) {
            group.newTabContainer = null;
        }

        group.catchTabContainers = group.catchTabContainers.filter(cookieStoreId => allContainers[cookieStoreId]);
    });

    return groups ? _groups : Groups.save(_groups);
}

// { reason: "update", previousVersion: "3.0.1", temporary: true }
// { reason: "install", temporary: true }
browser.runtime.onInstalled.addListener(function onInstalled({previousVersion, reason, temporary}) {
    if (!window.BG.inited) {
        setTimeout(onInstalled, 300, {previousVersion, reason, temporary});
        return;
    }

    if (temporary) {
        window.IS_PRODUCTION = false;
        console.restart();
        return;
    }

    if (browser.runtime.OnInstalledReason.INSTALL === reason ||
        (browser.runtime.OnInstalledReason.UPDATE === reason && -1 === utils.compareVersions(previousVersion, '4.0'))) {
        openHelp('welcome-v4');
    }
});

async function init() {
    let isAllowedIncognitoAccess = await browser.extension.isAllowedIncognitoAccess();

    if (isAllowedIncognitoAccess) {
        openHelp('disable-incognito');
        throw '';
    }

    let data = await storage.get(null);

    if (!Array.isArray(data.groups)) {
        utils.notify(browser.i18n.getMessage('ffFailedAndLostDataMessage'));

        data.groups = [];
    }

    await containers.init();

    try {
        data = await runMigrateForData(data); // run migration for data
    } catch (e) {
        utils.notify(String(e));
        throw '';
    }

    data.groups = await normalizeContainersInGroups(data.groups);

    options = utils.extractKeys(data, constants.allOptionsKeys, true);

    let windows = await Windows.load(true);

    if (!windows.length) {
        utils.notify(browser.i18n.getMessage('nowFoundWindowsAddonStoppedWorking'));
        throw '';
    }

    if (windows.some(win => win.tabs.some(tab => isStgNewTabUrl(tab.url)))) {
        windows = await removeSTGNewTabUrls(windows);
    }

    let withoutSession = data.withoutSession;
    delete data.withoutSession;

    if (withoutSession) { // if version < 4
        let tempTabs = await Promise.all(windows.map(win => Tabs.createTempActiveTab(win.id)));

        data.groups = await syncTabs(data.groups, windows, true);

        tempTabs = tempTabs.filter(Boolean);

        if (tempTabs.length) {
            await Tabs.remove(tempTabs.map(utils.keyId));
        }

        windows = await Windows.load(true);
    }

    await Promise.all(windows.map(async function(win) {
        if (win.session.groupId && !data.groups.some(group => group.id === win.session.groupId)) {
            delete win.session.groupId;
            await cache.removeWindowGroup(win.id);
        }

        if (win.session.groupId) {
            let showedTabs = [],
                tabIdsToShow = [],
                tabIdsToHide = [],
                tabToHideIsActive = false,
                moveTabsToWin = {};

            win.tabs.forEach(function(tab) {
                if (tab.session.groupId === win.session.groupId) {
                    if (tab.hidden) {
                        tabIdsToShow.push(tab.id);
                    }

                    showedTabs.push(tab);
                } else {
                    if (tab.session.groupId) {
                        if (data.groups.some(group => group.id === tab.session.groupId)) {
                            let tabsWin = windows.find(w => w.session.groupId === tab.session.groupId);

                            if (tabsWin) {
                                if (!moveTabsToWin[tabsWin.id]) {
                                    moveTabsToWin[tabsWin.id] = [];
                                }

                                moveTabsToWin[tabsWin.id].push(tab);

                                if (tab.hidden) {
                                    tabIdsToShow.push(tab.id);
                                }

                                return;
                            }
                        } else {
                            delete tab.session.groupId;
                            cache.removeTabGroup(tab.id);
                        }
                    } else if (utils.isTabLoading(tab) || (tab.url.startsWith('file:///') && !tab.hidden)) {
                        cache.setTabGroup(tab.id, win.session.groupId);
                        tab.session = cache.getTabSession(tab.id);
                        return;
                    }

                    if (!tab.hidden) {
                        if (tab.active) {
                            tabToHideIsActive = true;
                        }

                        tabIdsToHide.push(tab.id);
                    }
                }
            });

            for (let winId in moveTabsToWin) {
                await Tabs.moveNative(moveTabsToWin[winId], {
                    index: -1,
                    windowId: Number(winId),
                });
            }

            if (tabIdsToShow.length) {
                await browser.tabs.show(tabIdsToShow);
            }

            if (tabIdsToHide.length) {
                if (tabToHideIsActive) {
                    if (showedTabs.length) {
                        await Tabs.setActive(undefined, showedTabs);
                    } else {
                        await Tabs.createTempActiveTab(win.id, false);
                    }
                }

                await browser.tabs.hide(tabIdsToHide);
            }
        } else {
            let tabsToHide = [];

            win.tabs.forEach(function(tab) {
                if (tab.session.groupId) {
                    if (data.groups.some(group => tab.session.groupId === group.id)) {
                        tabsToHide.push(tab);
                    } else {
                        delete tab.session.groupId;
                        cache.removeTabGroup(tab.id);
                    }
                }
            });

            if (tabsToHide.length) {
                if (tabsToHide.some(tab => tab.active)) {
                    let visibleTabs = win.tabs.filter(tab => !tab.hidden && !tab.session.groupId);

                    if (visibleTabs.length) {
                        await Tabs.setActive(null, visibleTabs);
                    } else {
                        await Tabs.createTempActiveTab(win.id, false);
                    }
                }

                await browser.tabs.hide(tabsToHide.map(utils.keyId));
            }
        }
    }));

    if (data.isBackupRestoring) {
        delete data.isBackupRestoring;
        await storage.remove('isBackupRestoring');
        utils.notify(browser.i18n.getMessage('backupSuccessfullyRestored'));
    }

    await storage.set(data);

    resetAutoBackup();

    windows = await Windows.load();

    windows.forEach(function(win) {
        updateBrowserActionData(null, win.id);

        if (win.session.groupId) {
            groupsHistory.add(win.session.groupId);
        }
    });

    createMoveTabMenus();

    addEvents();

    window.BG.inited = true;
}

setBrowserAction(undefined, 'loading', undefined, false);

init()
    .then(function() {
        // send message for addon plugins
        sendExternalMessage({
            action: 'i-am-back',
        });

        // send message for addon options page if it's open
        sendMessage({
            action: 'i-am-back',
        });

        setBrowserAction(undefined, undefined, undefined, true);
    })
    .catch(function(e) {
        setBrowserAction(undefined, 'lang:clickHereToReloadAddon', '/icons/exclamation-triangle-yellow.svg', true);

        browser.browserAction.setPopup({
            popup: '',
        });

        browser.browserAction.onClicked.addListener(() => browser.runtime.reload());

        if (e) {
            utils.errorEventHandler(e);
        }
    });
