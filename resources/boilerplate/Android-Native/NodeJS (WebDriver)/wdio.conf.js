// wdio v7 is required — the Digital.ai Appium Grid rejects Appium client v8+.
// Do NOT upgrade to wdio v9 and do NOT run 'npm init wdio' (it installs v9 by default).
exports.config = {
    runner: 'local',
    hostname: '[Enter Instance HOST here]',
    protocol: 'https',
    port: 443,
    path: '/wd/hub',
    specs: ['./test/specs/AndroidNative.js'],
    exclude: [],
    maxInstances: 1,
    capabilities: [{
        platformName: 'ANDROID',
        'digitalai:testName': '[Enter Test Name here]',
        'digitalai:accessKey': '[Enter Your Access key here]',
        // Use appium: prefix — wdio v7 client validator requires W3C-format capabilities.
        // The platform accepts them via the desiredCapabilities fallback wdio sends automatically.
        'appium:app': 'cloud:com.experitest.ExperiBank/.LoginActivity',
        'appium:appPackage': 'com.experitest.ExperiBank',
        'appium:appActivity': '.LoginActivity',
        'digitalai:deviceQuery': "@os='android' and @category='[Enter PHONE/TABLET here]'",
        'autoDismissAlerts': true,
        'autoGrantPermissions': true,
        // System-level overlays (charging dialog, USB prompt) are NOT caught by autoDismissAlerts.
        // To clear them, run in an afterTest hook: browser.execute('mobile: shell', [{command:'am',args:['broadcast','-a','android.intent.action.CLOSE_SYSTEM_DIALOGS']}])
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
