const AppScreen = require('./AppScreen');

// ⛔ PLACEHOLDER SCREEN — the selectors below are NOT real. Replace every <…> with a value captured from a live
// inspection (start_inspection_session -> get_element_tree / find_elements, or open_mobile_studio), rename the class to
// the screen it represents, and add one such class per screen. NEVER guess a resource-id or accessibility id.
class PlaceholderScreen extends AppScreen {
    get primaryField() { return this.platform('id=<resource-id from get_element_tree>', '~<accessibility id from get_element_tree>'); }
    get primaryButton() { return this.platform('id=<resource-id>', '~<accessibility id>'); }

    async enterValue(value) {
        await this.type(this.primaryField, value);
        return this;
    }

    async tapPrimaryButton() {
        await this.tap(this.primaryButton);
        return this;
    }
}

module.exports = PlaceholderScreen;
