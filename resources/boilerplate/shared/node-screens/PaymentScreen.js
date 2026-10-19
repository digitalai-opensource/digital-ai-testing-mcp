const AppScreen = require('./AppScreen');

class PaymentScreen extends AppScreen {
    get phone() { return this.platform('id=com.experitest.ExperiBank:id/phoneTextField', '~phoneTextField'); }
    get name() { return this.platform('id=com.experitest.ExperiBank:id/nameTextField', '~nameTextField'); }
    get amount() { return this.platform('id=com.experitest.ExperiBank:id/amountTextField', '~amountTextField'); }
    get countryButton() { return this.platform('id=com.experitest.ExperiBank:id/countryButton', '~countryButton'); }
    get sendPaymentButton() { return this.platform('id=com.experitest.ExperiBank:id/sendPaymentButton', '~sendPaymentButton'); }
    // The confirmation is a system dialog on Android and a named button on iOS.
    get confirmYes() { return this.platform('id=android:id/button1', '~Yes'); }

    async fillPayment(phoneNumber, payee, amountValue, country) {
        await this.type(this.phone, phoneNumber);
        await this.type(this.name, payee);
        await this.type(this.amount, amountValue);
        await this.tap(this.countryButton);
        // Country list entry: visible text on Android, accessibility id (= label) on iOS.
        await this.tap(this.platform(`//*[@text="${country}"]`, `~${country}`));
        return this;
    }

    async sendAndConfirm() {
        await this.tap(this.sendPaymentButton);
        await this.tap(this.confirmYes);
    }
}

module.exports = PaymentScreen;
