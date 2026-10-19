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
    // Parallel runs: each spec file gets its own device session — raise this to the number of workers you want
    // (check the project's maxDevelopmentLicense and free matching devices first) and split tests across spec files.
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
        // wdio 7's validator rejects these unprefixed too ("Invalid or unsupported WebDriver capabilities", live 2026-10-17).
        'appium:autoDismissAlerts': true,
        'appium:autoGrantPermissions': true,
        // System-level overlays (charging dialog, USB prompt) are NOT caught by autoDismissAlerts.
        // To clear them, run in an afterTest hook (the object is the ONE execute argument — not wrapped in an array):
        //   browser.execute('mobile: shell', {command: 'am', args: ['broadcast', '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS']})
        // or, where the cloud does not enable the adb_shell feature: browser.execute('mobile: broadcast', {action: 'android.intent.action.CLOSE_SYSTEM_DIALOGS'})
    }],
    logLevel: 'info',
    bail: 0,
    // Native apps on a device farm need longer than the wdio default: the first $() races app install + launch.
    waitforTimeout: 45000,
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
