// wdio v7 is required — the Digital.ai Appium Grid rejects Appium client v8+.
// Do NOT upgrade to wdio v9 and do NOT run 'npm init wdio' (it installs v9 by default).
exports.config = {
    runner: 'local',
    hostname: '[Enter Instance HOST here]',
    protocol: 'https',
    port: 443,
    path: '/wd/hub',
    specs: ['./test/specs/iOSNative.js'],
    exclude: [],
    maxInstances: 1,
    capabilities: [{
        platformName: 'IOS',
        'digitalai:testName': '[Enter Test Name here]',
        'digitalai:accessKey': '[Enter Your Access key here]',
        // Use appium: prefix — wdio v7 client validator requires W3C-format capabilities.
        // The platform accepts them via the desiredCapabilities fallback wdio sends automatically.
        'appium:app': 'cloud:com.experitest.ExperiBank',
        'appium:bundleId': 'com.experitest.ExperiBank',
        'digitalai:deviceQuery': "@os='ios' and @category='[Enter PHONE/TABLET here]'",
    }],
    logLevel: 'info',
    bail: 0,
    waitforTimeout: 10000,
    connectionRetryTimeout: 120000,
    connectionRetryCount: 3,
    framework: 'mocha',
    reporters: ['spec'],
    mochaOpts: {
        ui: 'bdd',
        timeout: 180000,
    },
    afterSession: function (config, capabilities) {
        const reportUrl = capabilities['digitalai:reportUrl'];
        const reportTestId = capabilities['digitalai:reportTestId'];
        if (reportUrl) console.log('Report URL:', reportUrl);
        if (reportTestId) console.log('Report Test ID:', reportTestId);
    },
}
