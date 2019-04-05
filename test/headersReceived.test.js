/**
* Integrations tests for when headers are received by the extension
*
* @author: Alex Davidson
*/
import rewire from "rewire";
const workflow = rewire("../addon/compiled/test_compiled.js");
const URL = window.URL;

/**
* Functions
*/
const CACHED_COMMITMENTS_STRING = "cached-commitments";
const CHL_BYPASS_SUPPORT = workflow.__get__("CHL_BYPASS_SUPPORT");
const CHL_BYPASS_RESPONSE = workflow.__get__("CHL_BYPASS_RESPONSE");
const ACTIVE_CONFIG = workflow.__get__("ACTIVE_CONFIG");
const EXAMPLE_HREF = "https://www.example.com";
const processHeaders = workflow.__get__("processHeaders");
const isBypassHeader = workflow.__get__("isBypassHeader");
const setConfig = workflow.__get__("setConfig");
const updateIconMock = jest.fn();
function getMock() {
    return 1;
}
const setMock = jest.fn();
const clearCachedCommitmentsMock = function() {
    localStorage[CACHED_COMMITMENTS_STRING] = null;
};

/**
 * local storage set up
 */
const localStorage = new Map();
localStorage.clear = function() {
    localStorage.data = null;
};
beforeEach(() => {
    localStorage.data = "some_token";
    workflow.__set__("localStorage", localStorage);
    setConfig(1); // set the CF config
});

/**
* Tests
* (Currently unable to test workflows that are dependent on cookies)
*/
describe("ensure that errors are handled properly", () => {
    const CHL_VERIFICATION_ERROR = ACTIVE_CONFIG["error-codes"]["verify-error"];
    const CHL_CONNECTION_ERROR = ACTIVE_CONFIG["error-codes"]["connection-error"];

    const url = new URL(EXAMPLE_HREF);
    test("connection error", () => {
        function processConnError() {
            const details = {
                responseHeaders: [{name: CHL_BYPASS_RESPONSE, value: CHL_CONNECTION_ERROR}],
            };
            processHeaders(details, url);
        }
        expect(processConnError).toThrowError("error code: 5");
        expect(localStorage.data).toBeTruthy();
    });
    test("verification error", () => {
        function processVerifyError() {
            const details = {
                responseHeaders: [{name: CHL_BYPASS_RESPONSE, value: CHL_VERIFICATION_ERROR}],
            };
            processHeaders(details, url);
        }
        expect(processVerifyError).toThrowError("error code: 6");
        expect(localStorage.data).toBeFalsy();
    });
});

describe("check bypass header is working", () => {
    let found;
    beforeEach(() => {
        found = false;
    });

    test("header is valid", () => {
        const header = {name: CHL_BYPASS_SUPPORT, value: "1"};
        found = isBypassHeader(header);
        expect(found).toBeTruthy();
    });
    test("header is invalid value", () => {
        const header = {name: CHL_BYPASS_SUPPORT, value: "0"};
        found = isBypassHeader(header);
        expect(found).toBeFalsy();
    });
    test("header is invalid name", () => {
        const header = {name: "Different-header-name", value: "1"};
        found = isBypassHeader(header);
        expect(found).toBeFalsy();
    });
    test("config is reset if ID changes", () => {
        workflow.__set__("CONFIG_ID", 2);
        const header = {name: CHL_BYPASS_SUPPORT, value: "1"};
        found = isBypassHeader(header);
        expect(found).toBeTruthy();
        expect(updateIconMock).toBeCalledTimes(2);
    });
    test("config is not reset if ID does not change", () => {
        const header = {name: CHL_BYPASS_SUPPORT, value: "1"};
        found = isBypassHeader(header);
        expect(found).toBeTruthy();
        expect(updateIconMock).toBeCalledTimes(1);
    });
});

describe("check redemption attempt conditions", () => {
    const CHL_BYPASS_SUPPORT = "cf-chl-bypass";
    let url;
    let details;
    let header;
    // We have to set mock functions for testing
    setMockFunctions();
    beforeEach(() => {
        header = {name: CHL_BYPASS_SUPPORT, value: "1"};
        details = {
            statusCode: 403,
            responseHeaders: [header],
        };
        url = new URL("http://www.example.com");
    });

    test("check that favicon urls are ignored", () => {
        url = new URL("https://captcha.website/favicon.ico");
        const ret = processHeaders(details, url);
        expect(ret.attempted).toBeFalsy();
        expect(ret.xhr).toBeFalsy();
        expect(ret.favicon).toBeTruthy();
        expect(updateIconMock).toBeCalledTimes(1);
    });

    test("check that redemption is not fired on CAPTCHA domain", () => {
        url = new URL("https://captcha.website");
        const ret = processHeaders(details, url);
        expect(ret.attempted).toBeFalsy();
        expect(ret.xhr).toBeFalsy();
        expect(ret.favicon).toBeFalsy();
    });

    test("redemption is attempted on general domains", () => {
        const ret = processHeaders(details, url);
        expect(ret.attempted).toBeTruthy();
        expect(ret.xhr).toBeFalsy();
        expect(ret.favicon).toBeFalsy();
        expect(updateIconMock).toBeCalledTimes(2);
    });

    test("not fired if status code != 403", () => {
        details.statusCode = 200;
        const ret = processHeaders(details, url);
        expect(ret.attempted).toBeFalsy();
        expect(ret.xhr).toBeFalsy();
        expect(ret.favicon).toBeFalsy();
    });

    test("if count is 0 update icon", () => {
        getMock = function() {
            return 0;
        };
        workflow.__set__("get", getMock);
        processHeaders(details, url);
        expect(updateIconMock).toBeCalledTimes(3);
    });

    describe("setting of readySign", () => {
        beforeEach(() => {
            getMock = function() {
                return 0;
            };
            workflow.__set__("get", getMock);
        });

        describe("signing enabled", () => {
            beforeEach(() => {
                workflow.__set__("DO_SIGN", true);
                workflow.__set__("readySign", false);
            });

            test("no tokens", () => {
                const ret = processHeaders(details, url);
                expect(ret.attempted).toBeFalsy();
                expect(ret.xhr).toBeFalsy();
                expect(ret.favicon).toBeFalsy();
                const readySign = workflow.__get__("readySign");
                expect(readySign).toBeTruthy();
                expect(updateIconMock).toBeCalledWith("!");
            });

            test("not activated", () => {
                header = {name: "Different-header-name", value: "1"};
                details.responseHeaders = [header];
                const ret = processHeaders(details, url);
                expect(ret.attempted).toBeFalsy();
                expect(ret.xhr).toBeFalsy();
                expect(ret.favicon).toBeFalsy();
                const readySign = workflow.__get__("readySign");
                expect(readySign).toBeFalsy();
            });

            test("tokens > 0", () => {
                getMock = function() {
                    return 2;
                };
                workflow.__set__("get", getMock);
                const ret = processHeaders(details, url);
                expect(ret.attempted).toBeTruthy();
                expect(ret.xhr).toBeFalsy();
                expect(ret.favicon).toBeFalsy();
                const readySign = workflow.__get__("readySign");
                expect(readySign).toBeFalsy();
            });

            test("tokens > 0 but captcha.website", () => {
                url = new URL("https://captcha.website");
                getMock = function() {
                    return 2;
                };
                workflow.__set__("get", getMock);
                const ret = processHeaders(details, url);
                expect(ret.attempted).toBeFalsy();
                expect(ret.xhr).toBeFalsy();
                expect(ret.favicon).toBeFalsy();
                const readySign = workflow.__get__("readySign");
                expect(readySign).toBeTruthy();
            });

            test("redemption off", () => {
                workflow.__set__("DO_REDEEM", false);
                const ret = processHeaders(details, url);
                expect(ret.attempted).toBeFalsy();
                expect(ret.xhr).toBeFalsy();
                expect(ret.favicon).toBeFalsy();
                const readySign = workflow.__get__("readySign");
                expect(readySign).toBeTruthy();
            });
        });

        describe("signing disabled", () => {
            beforeEach(() => {
                workflow.__set__("readySign", false);
                workflow.__set__("DO_SIGN", false);
            });

            test("signing is not activated", () => {
                header = {name: "Different-header-name", value: "1"};
                details.responseHeaders = [header];
                const ret = processHeaders(details, url);
                expect(ret.attempted).toBeFalsy();
                expect(ret.xhr).toBeFalsy();
                expect(ret.favicon).toBeFalsy();
                const readySign = workflow.__get__("readySign");
                expect(readySign).toBeFalsy();
            });
        });
    });

    describe("xhr for empty response headers", () => {
        beforeEach(() => {
            const mockXhr = () => {
                // set up xhr
                const _xhr = {};
                _xhr.open = function(method, url) {
                    _xhr.method = method;
                    _xhr.url = url;
                };
                _xhr.responseHeaders = new Map();
                _xhr.getResponseHeader = function(name) {
                    return _xhr.responseHeaders[name];
                };
                _xhr.setResponseHeader = function(name, value) {
                    _xhr.responseHeaders[name] = value;
                };
                _xhr.overrideMimeType = jest.fn();
                _xhr.body;
                _xhr.send = jest.fn();
                _xhr.onreadystatechange = function() {};
                _xhr.status = 403;
                _xhr.readyState = 2;
                _xhr.HEADERS_RECEIVED = new window.XMLHttpRequest().HEADERS_RECEIVED;
                _xhr.abort = jest.fn();
                return _xhr;
            };
            workflow.__set__("XMLHttpRequest", mockXhr);
            // empty response headers
            details.responseHeaders = [];
            // set empty-resp-headers method
            workflow.__set__("EMPTY_RESP_HEADERS", ["direct-request"]);
        });

        test("direct request is not used if direct-request isn't included in empty-resp-headers", () => {
            workflow.__set__("EMPTY_RESP_HEADERS", []);
            const ret = processHeaders(details, url);
            expect(ret.attempted).toBeFalsy();
            expect(ret.xhr).toBeFalsy();
            expect(ret.favicon).toBeFalsy();
            expect(updateIconMock).toBeCalledTimes(1);
        });

        test("direct request is not used if response headers are not empty", () => {
            const someHeader = {name: "some-name", value: "some-value"};
            details.responseHeaders = [someHeader];
            const ret = processHeaders(details, url);
            expect(ret.attempted).toBeFalsy();
            expect(ret.xhr).toBeFalsy();
            expect(ret.favicon).toBeFalsy();
            expect(updateIconMock).toBeCalledTimes(1);
        });

        test("direct request does nothing if status code != 403", () => {
            const ret = processHeaders(details, url);
            expect(ret.attempted).toBeFalsy();
            expect(ret.xhr).toBeTruthy();
            expect(ret.favicon).toBeFalsy();
            expect(updateIconMock).toBeCalledTimes(1);
            const xhr = ret.xhr;
            xhr.status = 200;
            xhr.setResponseHeader("cf-chl-bypass", 1);
            const b = xhr.onreadystatechange();
            expect(b).toBeFalsy();
            expect(xhr.abort).toBeCalled();
        });

        test("direct request does nothing if CHL_BYPASS_SUPPORT header not received", () => {
            const ret = processHeaders(details, url);
            expect(ret.attempted).toBeFalsy();
            expect(ret.xhr).toBeTruthy();
            expect(ret.favicon).toBeFalsy();
            expect(updateIconMock).toBeCalledTimes(1);
            const xhr = ret.xhr;
            xhr.status = 403;
            xhr.setResponseHeader("some-header", 1);
            const b = xhr.onreadystatechange();
            expect(b).toBeFalsy();
            expect(xhr.abort).toBeCalled();
        });

        test("direct request does nothing if CHL_BYPASS_SUPPORT header has wrong value", () => {
            const ret = processHeaders(details, url);
            expect(ret.attempted).toBeFalsy();
            expect(ret.xhr).toBeTruthy();
            expect(ret.favicon).toBeFalsy();
            expect(updateIconMock).toBeCalledTimes(1);
            const xhr = ret.xhr;
            xhr.status = 403;
            xhr.setResponseHeader(CHL_BYPASS_SUPPORT, 2);
            const b = xhr.onreadystatechange();
            expect(b).toBeFalsy();
            expect(xhr.abort).toBeCalled();
        });

        test("direct request results in possible spend if CHL_BYPASS_SUPPORT header received", () => {
            const ret = processHeaders(details, url);
            expect(ret.attempted).toBeFalsy();
            expect(ret.xhr).toBeTruthy();
            expect(ret.favicon).toBeFalsy();
            expect(updateIconMock).toBeCalledTimes(1);
            const xhr = ret.xhr;
            xhr.status = 403;
            xhr.setResponseHeader(CHL_BYPASS_SUPPORT, 1);
            const b = xhr.onreadystatechange();
            expect(b).toBeTruthy();
            expect(xhr.abort).toBeCalled();
        });
    });
});

function setMockFunctions() {
    function attemptRedeemMock() {
        return true;
    }
    workflow.__set__("attemptRedeem", attemptRedeemMock);
    workflow.__set__("get", getMock);
    workflow.__set__("set", setMock);
    workflow.__set__("clearCachedCommitments", clearCachedCommitmentsMock);
    workflow.__set__("updateIcon", updateIconMock);
}
