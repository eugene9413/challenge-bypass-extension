/**
 * This background page handles the sending requests and dealing with responses.
 * Passes are exchanged with the server containing blinded tokens for bypassing CAPTCHAs.
 * Control flow is handled in the listeners. Cryptography uses SJCL.
 *
 * @author: George Tankersley
 * @author: Alex Davidson
 */

/* exported handleCompletion */
/* exported handleMessage */
/* exported processRedirect */
/* exported processHeaders */
/* exported beforeSendHeaders */
/* exported beforeRequest */
/* exported resetSpendVars */
/* exported committedNavigation */
/* exported cookiesChanged */
/* exported CHL_CAPTCHA_DOMAIN */
/* exported CHL_CLEARANCE_COOKIE */
/* exported REDEEM_METHOD */
/* exported RELOAD_ON_SIGN */
/* exported spentTab, timeSinceLastResp, futureReload, sentTokens */
/* exported DEV */
/* exported COMMITMENTS_KEY */
/* exported STORAGE_KEY_TOKENS, STORAGE_KEY_COUNT */
/* exported SEND_H2C_PARAMS, MAX_TOKENS, SIGN_RESPONSE_FMT, TOKENS_PER_REQUEST */
/* exported CONFIG_ID */
/* exported ISSUE_ACTION_URLS */
/* exported LISTENER_URLS */
"use strict";

const LISTENER_URLS = "<all_urls>";
/* Config variables that are reset in setConfig() depending on the header value that is received (see config.js) */
let CONFIG_ID = ACTIVE_CONFIG["id"];
let DEV = ACTIVE_CONFIG["dev"];
let CHL_CLEARANCE_COOKIE = ACTIVE_CONFIG["cookies"]["clearance-cookie"];
let CHL_CAPTCHA_DOMAIN = ACTIVE_CONFIG["captcha-domain"]; // cookies have dots prepended
let CHL_VERIFICATION_ERROR = ACTIVE_CONFIG["error-codes"]["verify-error"];
let CHL_CONNECTION_ERROR = ACTIVE_CONFIG["error-codes"]["connection-error"];
let COMMITMENTS_KEY = ACTIVE_CONFIG["commitments"];
let SPEND_MAX = ACTIVE_CONFIG["max-spends"];
let MAX_TOKENS = ACTIVE_CONFIG["max-tokens"];
let DO_SIGN = ACTIVE_CONFIG["sign"];
let DO_REDEEM = ACTIVE_CONFIG["redeem"];
let REDEEM_METHOD = ACTIVE_CONFIG["spend-action"]["redeem-method"];
let HEADER_NAME = ACTIVE_CONFIG["spend-action"]["header-name"];
let HEADER_HOST_NAME = ACTIVE_CONFIG["spend-action"]["header-host-name"];
let HEADER_PATH_NAME = ACTIVE_CONFIG["spend-action"]["header-path-name"];
let SPEND_ACTION_URLS = ACTIVE_CONFIG["spend-action"]["urls"];
let SPEND_STATUS_CODE = ACTIVE_CONFIG["spending-restrictions"]["status-code"];
let MAX_REDIRECT = ACTIVE_CONFIG["spending-restrictions"]["max-redirects"];
let NEW_TABS = ACTIVE_CONFIG["spending-restrictions"]["new-tabs"];
let BAD_NAV = ACTIVE_CONFIG["spending-restrictions"]["bad-navigation"];
let BAD_TRANSITION = ACTIVE_CONFIG["spending-restrictions"]["bad-transition"];
let VALID_REDIRECTS = ACTIVE_CONFIG["spending-restrictions"]["valid-redirects"];
let VALID_TRANSITIONS = ACTIVE_CONFIG["spending-restrictions"]["valid-transitions"];
let VAR_RESET = ACTIVE_CONFIG["var-reset"];
let VAR_RESET_MS = ACTIVE_CONFIG["var-reset-ms"];
const STORAGE_STR = "bypass-tokens-";
const COUNT_STR = STORAGE_STR + "count-";
let STORAGE_KEY_TOKENS = STORAGE_STR + ACTIVE_CONFIG["id"];
let STORAGE_KEY_COUNT = COUNT_STR + ACTIVE_CONFIG["id"];
let H2C_PARAMS = ACTIVE_CONFIG["h2c-params"];
let SEND_H2C_PARAMS = ACTIVE_CONFIG["send-h2c-params"];
let ISSUE_ACTION_URLS = ACTIVE_CONFIG["issue-action"]["urls"];
let RELOAD_ON_SIGN = ACTIVE_CONFIG["issue-action"]["sign-reload"];
let SIGN_RESPONSE_FMT = ACTIVE_CONFIG["issue-action"]["sign-resp-format"];
let TOKENS_PER_REQUEST = ACTIVE_CONFIG["issue-action"]["tokens-per-request"];
let OPT_ENDPOINTS = ACTIVE_CONFIG["opt-endpoints"];
let EMPTY_RESP_HEADERS = ACTIVE_CONFIG["spend-action"]["empty-resp-headers"];

initECSettings(H2C_PARAMS);

// Used for resetting variables below
let timeSinceLastResp = 0;

// Prevent too many redirections from exhausting tokens
let redirectCount = new Map();

// Set if a spend has occurred for a req id
let spendId = new Map();

// used for checking if we've already spent a token for this host to
// prevent token DoS attacks
let spentHosts = new Map();

// Used for tracking spends globally
let spentUrl = new Map();

// We want to monitor attempted spends to check if we should remove cookies
const httpsRedirect = new Map();

// Monitor whether we have already sent tokens for signing
let sentTokens = new Map();

// URL string for determining where tokens should be spent
let target = new Map();

// Used for firefox primarily
let futureReload = new Map();

// Tabs that a spend occurred in
let spentTab = new Map();

// Track whether we should try to initiate a signing request
let readySign = false;

/**
 * Functions used by event listeners (listeners.js)
 */

/**
 * Runs when a request is completed
 * @param {Object} details HTTP request details
 */
function handleCompletion(details) {
    timeSinceLastResp = Date.now();
    // If we had a spend and we're using "reload" method then reload the page
    if (spendId[details.requestId] && REDEEM_METHOD === "reload") {
        reloadBrowserTab(details.tabId);
    }
    spendId[details.requestId] = false;
}

/**
 * If a redirect occurs then we want to see if we had spent previously
 * If so then it is likely that we will want to spend on the redirect
 * @param {Object} details contains the HTTP redirect info
 * @param {URL} oldUrl URL object of previous navigation
 * @param {URL} newUrl URL object of current redirection
 */
function processRedirect(details, oldUrl, newUrl) {
    httpsRedirect[newUrl.href] = validRedirect(oldUrl.href, newUrl.href);
    if (redirectCount[details.requestId] === undefined) {
        redirectCount[details.requestId] = 0;
    }
    if (spendId[details.requestId] && redirectCount[details.requestId] < MAX_REDIRECT) {
        setSpendFlag(newUrl.host, true);
        spendId[details.requestId] = false;
        redirectCount[details.requestId] = redirectCount[details.requestId] + 1;
    }
}

/**
 * Checks if a redirect is valid using the VALID_REDIRECTS config option
 * @param {URL} oldUrl
 * @param {URL} redirectUrl
 * @return {boolean}
 */
function validRedirect(oldUrl, redirectUrl) {
    if (oldUrl.includes("http://")) {
        const urlStr = oldUrl.substring(7);
        const valids = VALID_REDIRECTS;
        for (let i = 0; i < valids.length; i++) {
            const newUrl = valids[i] + urlStr;
            if (newUrl === redirectUrl) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Headers are received before document render. The blocking attributes allows
 * us to cancel requests instead of loading an unnecessary ReCaptcha widget.
 * @param {Object} details contains the HTTP response info
 * @param {URL} url request URL object
 * @return {boolean}
 */
function processHeaders(details, url) {
    const ret = {attempted: false, xhr: false, favicon: false};
    // We're not interested in running this logic for favicons
    if (isFaviconUrl(url.href)) {
        ret.favicon = true;
        return ret;
    }

    let activated = false;
    for (let i = 0; i < details.responseHeaders.length; i++) {
        const header = details.responseHeaders[i];
        if (header.name.toLowerCase() === CHL_BYPASS_RESPONSE) {
            if (header.value === CHL_VERIFICATION_ERROR
                || header.value === CHL_CONNECTION_ERROR) {
                // If these errors occur then something bad is happening.
                // Either tokens are bad or some resource is calling the server
                // in a bad way
                if (header.value === CHL_VERIFICATION_ERROR) {
                    clearStorage();
                }
                throw new Error("[privacy-pass]: There may be a problem with the stored tokens. Redemption failed for: " + url.href + " with error code: " + header.value);
            }
        }

        // correct status code with the right header indicates a bypassable Cloudflare CAPTCHA
        if (isBypassHeader(header) && SPEND_STATUS_CODE.includes(details.statusCode)) {
            activated = true;
        }
    }

    if (EMPTY_RESP_HEADERS.includes("direct-request")) {
        // There is some weirdness with Chrome whereby some resources return empty
        // responseHeaders but where a spend *should* occur. If this happens then we
        // send a direct request to an endpoint that determines whether a CAPTCHA
        // page is shown via XHR.
        ret.xhr = tryDirectRequest(details, url, ret);
    }

    // If we have tokens to spend, cancel the request and pass execution over to
    // the token handler.
    if (activated) {
        ret.attempted = decideRedeem(details, url);
    }
    return ret;
}

/**
 * Try a direct request against a challenge endpoint if the response headers are
 * empty. This fixes some strange behaviour with CF sites and Chrome.
 * @param {Object} details
 * @param {URL} url
 * @return {boolean} indicates whether an XHR was launched
 */
function tryDirectRequest(details, url) {
    if (details.responseHeaders.length === 0 && SPEND_STATUS_CODE.includes(details.statusCode)) {
        const xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function() {
            // We return a boolean in onreadystatechange for testing purposes
            let xhrRet = false;
            if (this.readyState === this.HEADERS_RECEIVED) {
                if (SPEND_STATUS_CODE.includes(xhr.status) && xhr.getResponseHeader(CHL_BYPASS_SUPPORT) === CONFIG_ID) {
                    decideRedeem(details, url);
                    xhr.abort();
                    xhrRet = true;
                }
                xhr.abort();
            }
            return xhrRet;
        };
        xhr.open("GET", url.origin + OPT_ENDPOINTS["challenge"], true);
        xhr.send();
        return xhr;
    }
    return;
}

/**
 * Decides whether to redeem a token for the given URL
 * @param {Object} details Response details
 * @param {URL} url URL object for possible redemption
 * @return {boolean}
 */
function decideRedeem(details, url) {
    let attempted = false;
    if (!spentUrl[url.href]) {
        const count = countStoredTokens();
        if (DO_REDEEM) {
            if (count > 0 && !url.host.includes(CHL_CAPTCHA_DOMAIN)) {
                attemptRedeem(url, details.tabId, target);
                attempted = true;
            } else if (count === 0) {
                // Update icon to show user that token may be spent here
                updateIcon("!");
            }
        }

        // If signing is permitted then we should note this
        if (!attempted && DO_SIGN) {
            readySign = true;
        }
    }
    return attempted;
}

/**
 * If a spend flag is set then we alter the request and add a header
 * containing a valid BlindTokenRequest for redemption
 * @param {Object} request HTTP request details
 * @param {URL} url URL object of request
 * @return {Object} an object containing new headers for the request
 */
function beforeSendHeaders(request, url) {
    // Cancel if we don't have a token to spend

    const reqUrl = url.href;
    const host = url.host;

    if (DO_REDEEM && !isErrorPage(reqUrl) && !isFaviconUrl(reqUrl) && !checkMaxSpend(host) && getSpendFlag(host)) {
        // No reload method branch
        if (REDEEM_METHOD === "no-reload") {
            // check that we're at an URL that can handle redeems
            const isRedeemUrl = SPEND_ACTION_URLS
                .map((redeemUrl) => patternToRegExp(redeemUrl))
                .some((re) => reqUrl.match(re));

            setSpendFlag(url.host, null);

            if (countStoredTokens() > 0 && isRedeemUrl) {
                const tokenToSpend = GetTokenForSpend();
                if (tokenToSpend == null) {
                    return {cancel: false};
                }
                setSpendFlag(host, null);
                incrementSpentHost(host);

                const httpPath = request.method + " " + url.pathname;
                const redemptionString = BuildRedeemHeader(tokenToSpend, url.hostname, httpPath);
                const headers = request.requestHeaders;
                headers.push({name: HEADER_NAME, value: redemptionString});
                headers.push({name: HEADER_HOST_NAME, value: url.hostname});
                headers.push({name: HEADER_PATH_NAME, value: httpPath});
                spendId[request.requestId] = true;
                spentUrl[reqUrl] = true;
                if (!spentTab[request.tabId]) {
                    spentTab[request.tabId] = [];
                }
                spentTab[request.tabId].push(url.href);
                return {requestHeaders: headers};
            }
        } else if (REDEEM_METHOD === "reload" && !spentUrl[reqUrl]) {
            return getReloadHeaders(request, url);
        }
    }

    return {cancel: false};
}

/**
 * Creates redemption headers if the tab should be reloaded
 * @param {Object} request HTTP request details
 * @param {URL} url URL of the request
 * @return {Object} contains new header objects
 */
function getReloadHeaders(request, url) {
    const headers = request.requestHeaders;
    setSpendFlag(url.host, null);
    incrementSpentHost(url.host);
    target[request.tabId] = "";

    // Create a pass and reload to send it to the edge
    const tokenToSpend = GetTokenForSpend();
    if (tokenToSpend == null) {
        return {cancel: false};
    }

    const method = request.method;
    const httpPath = method + " " + url.pathname;
    const redemptionString = BuildRedeemHeader(tokenToSpend, url.hostname, httpPath);
    const newHeader = {name: HEADER_NAME, value: redemptionString};
    headers.push(newHeader);
    spendId[request.requestId] = true;
    spentUrl[url.href] = true;
    if (!spentTab[request.tabId]) {
        spentTab[request.tabId] = [];
    }
    spentTab[request.tabId].push(url.href);
    return {requestHeaders: headers};
}

/**
 * Filters requests before we've made a connection. If a challenge is observed
 * and we don't have available tokens to spend then it sends tokens to the
 * server.
 * @param {Object} details HTTP request details
 * @param {URL} url URL object of request
 * @return {Object} contains XHR details for sending tokens
 */
function beforeRequest(details, url) {
    // Clear vars if they haven't been used for a while
    if (VAR_RESET && Date.now() - VAR_RESET_MS > timeSinceLastResp) {
        resetVars();
    }

    // Only sign tokens if config says so and the appropriate header was received previously
    if (!DO_SIGN || !readySign) {
        return false;
    }

    // Different signing methods based on configs
    let xhrInfo;
    switch (CONFIG_ID) {
        case 1:
            xhrInfo = signReqCF(url);
            break;
        case 2:
            xhrInfo = signReqHC(url);
            break;
        default:
            throw new Error("Incorrect config ID specified");
    }

    // If this is null then signing is not appropriate
    if (xhrInfo === null) {
        return false;
    }
    readySign = false;

    // actually send the token signing request via xhr and return the xhr object
    const xhr = sendXhrSignReq(xhrInfo, url, details.tabId);
    return {xhr: xhr};
}

/**
 * Set the target URL for the spend and update the tab if necessary. When
 * navigation is committed we may want to reload.
 * @param {Object} details Navigation details
 * @param {URL} url URL of navigation
 */
function committedNavigation(details, url) {
    const redirect = details.transitionQualifiers[0];
    const tabId = details.tabId;
    if (!BAD_NAV.includes(details.transitionType)
        && (!badTransition(url.href, redirect, details.transitionType))
        && !isNewTab(url.href)) {
        const id = getTabId(tabId);
        target[id] = url.href;
        // If a reload was attempted but target hadn't been inited then reload now
        if (futureReload[id] === target[id]) {
            futureReload[id] = false;
            updateBrowserTab(id, target[id]);
        }
    }
}

/**
 * Handles messages from the plugin HTML that need BG page functionality
 * @param {Object} request HTTP request details
 * @param {Object} sender Used by the plugin to communicate with the BG page
 * @param {Function} sendResponse sends the response back to the plugin HTML
 */
function handleMessage(request, sender, sendResponse) {
    if (request.callback) {
        UpdateCallback = request.callback;
    } else if (request.tokLen) {
        sendResponse(countStoredTokens());
    } else if (request.clear) {
        clearStorage();
    }
}

/* Token storage functions */

/**
 * Increments the number of spends for a given host
 * @param {string} host String corresponding to host
 */
function incrementSpentHost(host) {
    if (spentHosts[host] === undefined) {
        spentHosts[host] = 0;
    }
    spentHosts[host] = spentHosts[host] + 1;
}

/**
 * Checks whether the given host has not exceeded the max number of spends
 * @param {string} host
 * @return {boolean}
 */
function checkMaxSpend(host) {
    if (spentHosts[host] === undefined || spentHosts[host] < SPEND_MAX || !SPEND_MAX) {
        return false;
    }
    return true;
}

/**
 * Pops a token from storage for a redemption
 * @return {Object} token object
 */
function GetTokenForSpend() {
    let tokens = loadTokens();
    // prevent null checks
    if (tokens == null) {
        return null;
    }
    const tokenToSpend = tokens[0];
    tokens = tokens.slice(1);
    storeTokens(tokens);
    return tokenToSpend;
}


/**
 * Clears the stored tokens and other variables
 */
function clearStorage() {
    clear();
    resetVars();
    resetSpendVars();
    // Update icons
    updateIcon(0);
    UpdateCallback();
}

/* Utility functions */

/**
 * Indicates whether a bad state transition has occurred
 * @param {string} href href string of URL object
 * @param {string} type type of navigation
 * @param {string} transitionType type of state transition for navigation
 * @return {boolean}
 */
function badTransition(href, type, transitionType) {
    if (httpsRedirect[href]) {
        httpsRedirect[href] = false;
        return false;
    }
    const maybeGood = (VALID_TRANSITIONS.includes(transitionType));
    if (!type && !maybeGood) {
        return true;
    }
    return BAD_TRANSITION.includes(type);
}

/**
 * Checks if the tab is deemed to be new or not
 * @param {string} url string href of URL object
 * @return {boolean}
 */
function isNewTab(url) {
    for (let i = 0; i < NEW_TABS.length; i++) {
        if (url.includes(NEW_TABS[i])) {
            return true;
        }
    }
    return false;
}

/**
 * Reset variables
 */
function resetVars() {
    redirectCount = new Map();
    sentTokens = new Map();
    target = new Map();
    spendId = new Map();
    futureReload = new Map();
    spentHosts = new Map();
}

/**
 * Reset variables that are specifically used for restricting spending
 */
function resetSpendVars() {
    spentTab = new Map();
    spentUrl = new Map();
}

/**
 * Checks whether a header should activate the extension. The value dictates
 * whether to swap to a new configuration
 * @param {header} header
 * @return {boolean}
 */
function isBypassHeader(header) {
    const newConfigVal = parseInt(header.value);
    if (header.name.toLowerCase() === CHL_BYPASS_SUPPORT && newConfigVal !== 0) {
        if (newConfigVal !== CONFIG_ID) {
            setConfig(newConfigVal);
        }
        return true;
    }
    return false;
}

/**
 * Changes the active configuration when the client receives a new configuration
 * value.
 * @param {int} val
 */
function setConfig(val) {
    ACTIVE_CONFIG = PPConfigs[val];
    CONFIG_ID = ACTIVE_CONFIG["id"];
    DEV = ACTIVE_CONFIG["dev"];
    CHL_CLEARANCE_COOKIE = ACTIVE_CONFIG["cookies"]["clearance-cookie"];
    CHL_CAPTCHA_DOMAIN = ACTIVE_CONFIG["captcha-domain"]; // cookies have dots prepended
    CHL_VERIFICATION_ERROR = ACTIVE_CONFIG["error-codes"]["verify-error"];
    CHL_CONNECTION_ERROR = ACTIVE_CONFIG["error-codes"]["connection-error"];
    COMMITMENTS_KEY = ACTIVE_CONFIG["commitments"];
    SPEND_MAX = ACTIVE_CONFIG["max-spends"];
    MAX_TOKENS = ACTIVE_CONFIG["max-tokens"];
    DO_SIGN = ACTIVE_CONFIG["sign"];
    DO_REDEEM = ACTIVE_CONFIG["redeem"];
    STORAGE_KEY_TOKENS = STORAGE_STR + ACTIVE_CONFIG["id"];
    STORAGE_KEY_COUNT = COUNT_STR + ACTIVE_CONFIG["id"];
    REDEEM_METHOD = ACTIVE_CONFIG["spend-action"]["redeem-method"];
    HEADER_HOST_NAME = ACTIVE_CONFIG["spend-action"]["header-host-name"];
    HEADER_PATH_NAME = ACTIVE_CONFIG["spend-action"]["header-path-name"];
    SPEND_ACTION_URLS = ACTIVE_CONFIG["spend-action"]["urls"];
    HEADER_NAME = ACTIVE_CONFIG["spend-action"]["header-name"];
    SPEND_STATUS_CODE = ACTIVE_CONFIG["spending-restrictions"]["status-code"];
    CHECK_COOKIES = ACTIVE_CONFIG["cookies"]["check-cookies"];
    MAX_REDIRECT = ACTIVE_CONFIG["spending-restrictions"]["max-redirects"];
    NEW_TABS = ACTIVE_CONFIG["spending-restrictions"]["new-tabs"];
    BAD_NAV = ACTIVE_CONFIG["spending-restrictions"]["bad-navigation"];
    BAD_TRANSITION = ACTIVE_CONFIG["spending-restrictions"]["bad-transition"];
    VALID_REDIRECTS = ACTIVE_CONFIG["spending-restrictions"]["valid-redirects"];
    VALID_TRANSITIONS = ACTIVE_CONFIG["spending-restrictions"]["valid-transitions"];
    VAR_RESET = ACTIVE_CONFIG["var-reset"];
    VAR_RESET_MS = ACTIVE_CONFIG["var-reset-ms"];
    H2C_PARAMS = ACTIVE_CONFIG["h2c-params"];
    SEND_H2C_PARAMS = ACTIVE_CONFIG["send-h2c-params"];
    ISSUE_ACTION_URLS = ACTIVE_CONFIG["issue-action"]["urls"];
    RELOAD_ON_SIGN = ACTIVE_CONFIG["issue-action"]["sign-reload"];
    SIGN_RESPONSE_FMT = ACTIVE_CONFIG["issue-action"]["sign-resp-format"];
    TOKENS_PER_REQUEST = ACTIVE_CONFIG["issue-action"]["tokens-per-request"];
    OPT_ENDPOINTS = ACTIVE_CONFIG["opt-endpoints"];
    EMPTY_RESP_HEADERS = ACTIVE_CONFIG["spend-action"]["empty-resp-headers"];

    initECSettings(H2C_PARAMS);
    clearCachedCommitments();
    countStoredTokens();
}
