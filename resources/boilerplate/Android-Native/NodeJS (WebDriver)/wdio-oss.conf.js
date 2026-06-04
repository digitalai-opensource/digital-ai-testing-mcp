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
        'appium:app': 'cloud:com.experitest.ExperiBank/.LoginActivity',
        'appium:appPackage': 'com.experitest.ExperiBank',
        'appium:appActivity': '.LoginActivity',
        'digitalai:deviceQuery': "@os='android' and @category='[Enter PHONE/TABLET here]'",
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
