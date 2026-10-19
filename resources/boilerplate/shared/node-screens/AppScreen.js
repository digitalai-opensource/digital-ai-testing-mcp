// Base screen: every interaction waits explicitly (waitforTimeout in wdio.conf.js); locators are chosen per platform at
// runtime so one screen class serves the Android and the iOS build. Screens return the next screen.
class AppScreen {
    constructor() {
        this.isAndroid = browser.isAndroid;
    }

    platform(androidSelector, iosSelector) {
        return this.isAndroid ? androidSelector : iosSelector;
    }

    async find(selector) {
        const el = await $(selector);
        await el.waitForDisplayed();
        return el;
    }

    async tap(selector) {
        await (await this.find(selector)).click();
    }

    async type(selector, text) {
        await (await this.find(selector)).setValue(text);
    }
}

module.exports = AppScreen;
